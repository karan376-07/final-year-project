import time
import random
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from app.models.schemas import (
    EmailItem, GenerateReplyRequest, GenerateReplyResponse,
    ComposeEmailRequest, EmailSummary, ActionItem
)
from app.database.db import db
from app.services.gemini_service import gemini_service
from app.services.gmail_service import gmail_service
from app.auth.auth_handler import get_current_user, UserProfile

router = APIRouter(prefix="/api/emails", tags=["Emails"])

@router.get("/counts")
async def get_email_counts(current_user: UserProfile = Depends(get_current_user)):
    """Return aggregated mailbox counts for sidebar badges and quick stats."""
    all_emails = db.get_emails(folder="all", user_email=current_user.email)
    if not all_emails:
        await gmail_service.sync_inbox(user_email=current_user.email, user_name=current_user.name)
        all_emails = db.get_emails(folder="all", user_email=current_user.email)

    return {
        "all": len(all_emails),
        "inbox": sum(1 for e in all_emails if e.folder == "inbox"),
        "unread": sum(1 for e in all_emails if not e.is_read and e.folder == "inbox"),
        "starred": sum(1 for e in all_emails if e.is_starred),
        "sent": sum(1 for e in all_emails if e.folder == "sent"),
        "spam": sum(1 for e in all_emails if e.folder == "spam" or (hasattr(e.category, 'value') and e.category.value == "Spam") or str(e.category) == "Spam"),
        "trash": sum(1 for e in all_emails if e.folder == "trash"),
        "urgent": sum(1 for e in all_emails if (hasattr(e.priority, 'value') and e.priority.value == "High" or str(e.priority) == "High") and e.folder == "inbox")
    }

@router.get("", response_model=List[EmailItem])
async def list_emails(
    folder: str = Query("inbox"),
    category: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    unread_only: bool = Query(False),
    starred_only: bool = Query(False),
    has_attachments: Optional[bool] = Query(None),
    current_user: UserProfile = Depends(get_current_user)
):
    all_user_emails = db.get_emails(folder="all", user_email=current_user.email)
    if not all_user_emails:
        await gmail_service.sync_inbox(user_email=current_user.email, user_name=current_user.name)

    emails = db.get_emails(
        folder=folder,
        category=category,
        priority=priority,
        search=search,
        unread_only=unread_only,
        starred_only=starred_only,
        has_attachments=has_attachments,
        user_email=current_user.email
    )
    return emails


@router.get("/{email_id}", response_model=EmailItem)
def get_email(email_id: str, current_user: UserProfile = Depends(get_current_user)):
    """Fetch details of a specific email."""
    email = db.get_email_by_id(email_id)
    if not email:
        raise HTTPException(status_code=404, detail="Email not found")
    # Mark as read on open
    if not email.is_read:
        db.update_email(email_id, {"is_read": True})
        email.is_read = True
    return email

from app.services.imap_service import imap_service

@router.post("/sync")
async def sync_emails(current_user: UserProfile = Depends(get_current_user)):
    """Trigger email sync pipeline and AI categorization."""
    creds = db.get_user_credentials(current_user.email)
    if creds and creds.get("type") == "imap" and creds.get("imap_pass"):
        result = await imap_service.fetch_real_emails_via_imap(
            user_email=current_user.email,
            app_password=creds["imap_pass"]
        )
    else:
        result = await gmail_service.sync_inbox(
            user_email=current_user.email,
            user_name=current_user.name,
        )
    if result.get("status") in {"error", "disconnected"}:
        raise HTTPException(status_code=502, detail=result["message"])
    return result

@router.post("/sync-imap")
async def sync_imap_emails(app_password: str, current_user: UserProfile = Depends(get_current_user)):
    """Directly fetch real emails from Gmail IMAP using App Password."""
    return await imap_service.fetch_real_emails_via_imap(
        user_email=current_user.email,
        app_password=app_password
    )

@router.post("/{email_id}/toggle-read", response_model=EmailItem)
def toggle_read(email_id: str, current_user: UserProfile = Depends(get_current_user)):
    """Toggle read/unread status."""
    email = db.get_email_by_id(email_id)
    if not email:
        raise HTTPException(status_code=404, detail="Email not found")
    updated = db.update_email(email_id, {"is_read": not email.is_read})
    return updated

@router.post("/{email_id}/toggle-star", response_model=EmailItem)
def toggle_star(email_id: str, current_user: UserProfile = Depends(get_current_user)):
    """Toggle starred status."""
    email = db.get_email_by_id(email_id)
    if not email:
        raise HTTPException(status_code=404, detail="Email not found")
    updated = db.update_email(email_id, {"is_starred": not email.is_starred})
    return updated

@router.delete("/{email_id}")
def delete_email(email_id: str, current_user: UserProfile = Depends(get_current_user)):
    """Move email to trash or permanently remove if already in trash."""
    success = db.delete_email(email_id)
    if not success:
        raise HTTPException(status_code=404, detail="Email not found")
    return {"status": "success", "message": "Email deleted successfully"}

@router.post("/{email_id}/action-items/{task_idx}/toggle", response_model=EmailItem)
def toggle_action_item(email_id: str, task_idx: int, current_user: UserProfile = Depends(get_current_user)):
    """Mark an action item task as completed or pending."""
    email = db.get_email_by_id(email_id)
    if not email:
        raise HTTPException(status_code=404, detail="Email not found")
    if 0 <= task_idx < len(email.action_items):
        email.action_items[task_idx].completed = not email.action_items[task_idx].completed
        db.update_email(email_id, {"action_items": [i.model_dump() for i in email.action_items]})
    return email

@router.post("/generate-reply", response_model=GenerateReplyResponse)
async def generate_reply(req: GenerateReplyRequest, current_user: UserProfile = Depends(get_current_user)):
    """Generate smart AI email reply with selected tone."""
    subject = req.email_subject or ""
    body = req.email_body or ""
    sender_name = "Sender"
    
    if req.email_id:
        email = db.get_email_by_id(req.email_id)
        if email:
            subject = subject or email.subject
            body = body or email.body
            sender_name = email.sender_name

    res = await gemini_service.generate_smart_reply(
        subject=subject,
        body=body,
        sender_name=sender_name,
        tone=req.tone,
        custom_instructions=req.custom_instructions,
        user_name=current_user.name
    )
    return GenerateReplyResponse(**res)

@router.post("/summarize")
async def summarize_email_text(subject: str, body: str, sender: str = "Unknown", current_user: UserProfile = Depends(get_current_user)):
    """Summarize any email text payload using AI."""
    return await gemini_service.analyze_and_summarize_email(subject, body, sender)

@router.post("/compose", response_model=EmailItem)
async def compose_email(req: ComposeEmailRequest, current_user: UserProfile = Depends(get_current_user)):
    """Send / save composed outgoing email."""
    now = time.time()
    new_id = f"em-sent-{random.randint(1000, 9999)}"
    
    # Analyze outgoing email with AI
    analysis = await gemini_service.analyze_and_summarize_email(req.subject, req.body, current_user.name)
    
    email = EmailItem(
        id=new_id,
        sender_name=f"{current_user.name} (You)",
        sender_email=current_user.email,
        recipient_email=req.recipient,
        subject=req.subject,
        snippet=req.body[:120] + "...",
        body=req.body,
        category=req.category or analysis.get("category", "Work"),
        priority=req.priority or analysis.get("priority", "Medium"),
        date="Just now",
        timestamp=now,
        is_read=True,
        is_starred=False,
        has_attachments=bool(req.attachments),
        attachments=[],
        summary=EmailSummary(
            bullet_points=analysis.get("bullet_points", [req.subject]),
            one_liner=analysis.get("one_liner", req.subject),
            urgency_reason=analysis.get("urgency_reason"),
            sentiment=analysis.get("sentiment", "Neutral"),
            key_deadlines=analysis.get("deadlines", [])
        ),
        action_items=[],
        folder="sent"
    )
    db.add_email(email)
    
    # If sent to self or current user, also add an inbox copy for instant local receipt testing
    recip = (req.recipient or "").strip().lower()
    user_email_clean = (current_user.email or "").strip().lower()
    if recip == user_email_clean or "self" in recip or "me@" in recip or user_email_clean in recip:
        import copy
        inbox_copy = copy.deepcopy(email)
        inbox_copy.id = f"em-inbox-{random.randint(1000, 9999)}"
        inbox_copy.folder = "inbox"
        inbox_copy.is_read = False
        db.add_email(inbox_copy)

    return email
