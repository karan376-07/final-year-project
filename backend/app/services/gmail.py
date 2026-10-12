import os
import base64
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from app.config import settings
from app.models.email import EmailItem, AttachmentInfo, AISummary

logger = logging.getLogger("smart_email_assistant")

def get_gmail_service(credentials_dict: Dict[str, Any]):
    """Creates a Gmail API service instance."""
    try:
        if "access_token" in credentials_dict:
            token = credentials_dict["access_token"]
            creds = Credentials(
                token=token,
                refresh_token=credentials_dict.get("refresh_token"),
                token_uri=credentials_dict.get("token_uri", "https://oauth2.googleapis.com/token"),
                client_id=credentials_dict.get("client_id", settings.GOOGLE_CLIENT_ID),
                client_secret=credentials_dict.get("client_secret", settings.GOOGLE_CLIENT_SECRET)
            )
            return build('gmail', 'v1', credentials=creds)
        creds = Credentials.from_authorized_user_info(credentials_dict)
        return build('gmail', 'v1', credentials=creds)
    except Exception as e:
        logger.error(f"Failed to create Gmail service: {e}")
        return None

async def fetch_emails_from_gmail(user_email: str, credentials_dict: Dict[str, Any], max_results: int = 20) -> List[Dict[str, Any]]:
    """Fetches list of emails from Gmail API and parses them."""
    service = get_gmail_service(credentials_dict)
    if not service:
        raise RuntimeError("Could not initialize Gmail API client; check the OAuth credentials.")
    
    try:
        results = service.users().messages().list(userId='me', maxResults=max_results).execute()
        messages = results.get('messages', [])
        
        parsed_emails = []
        for msg in messages:
            msg_id = msg['id']
            # Fetch full message
            msg_data = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
            parsed = parse_gmail_message(msg_data, user_email)
            if parsed:
                parsed_emails.append(parsed)
                
        return parsed_emails
    except HttpError as error:
        logger.error(f"Gmail API error occurred: {error}")
        raise RuntimeError(f"Gmail API request failed: {error}") from error
    except Exception as e:
        logger.error(f"General error fetching Gmail: {e}")
        raise RuntimeError(f"Unable to fetch Gmail messages: {e}") from e

def parse_gmail_message(msg_data: Dict[str, Any], user_email: str) -> Optional[Dict[str, Any]]:
    """Helper to parse raw Gmail API response structure."""
    try:
        msg_id = msg_data['id']
        thread_id = msg_data['threadId']
        payload = msg_data.get('payload', {})
        headers = payload.get('headers', [])
        
        # Extract headers
        subject = next((h['value'] for h in headers if h['name'].lower() == 'subject'), '(No Subject)')
        sender = next((h['value'] for h in headers if h['name'].lower() == 'from'), 'Unknown Sender')
        date_str = next((h['value'] for h in headers if h['name'].lower() == 'date'), '')
        
        # Parse sender
        sender_name = sender
        sender_email = sender
        if '<' in sender and '>' in sender:
            parts = sender.split('<')
            sender_name = parts[0].strip()
            sender_email = parts[1].replace('>', '').strip()
            
        # Parse date
        try:
            # Use email utils or fallback
            from email.utils import parsedate_to_datetime
            date_dt = parsedate_to_datetime(date_str)
        except Exception:
            date_dt = datetime.now(timezone.utc)
            
        # Parse body
        body_snippet = msg_data.get('snippet', '')
        body_full = ""
        attachments = []
        
        # Extract parts
        parts = [payload]
        while parts:
            part = parts.pop(0)
            if part.get('parts'):
                parts.extend(part.get('parts'))
            
            # Text body
            if part.get('mimeType') == 'text/plain' and part.get('body', {}).get('data'):
                body_data = part['body']['data']
                body_data += '=' * (-len(body_data) % 4)
                body_full += base64.urlsafe_b64decode(body_data).decode('utf-8', errors='ignore')
            elif part.get('mimeType') == 'text/html' and not body_full and part.get('body', {}).get('data'):
                body_data = part['body']['data']
                # basic decode, text extraction can clean it
                body_data += '=' * (-len(body_data) % 4)
                body_full += base64.urlsafe_b64decode(body_data).decode('utf-8', errors='ignore')
                
            # Attachment info
            if part.get('filename') and part.get('body', {}).get('attachmentId'):
                attachments.append({
                    "filename": part['filename'],
                    "content_type": part['mimeType'],
                    "size": part['body'].get('size', 0),
                    "id": part['body']['attachmentId']
                })
                
        if not body_full:
            body_full = body_snippet or "No readable text content."
            
        return {
            "_id": msg_id,
            "thread_id": thread_id,
            "user_email": user_email,
            "sender_name": sender_name,
            "sender_email": sender_email,
            "subject": subject,
            "date": date_dt,
            "body_snippet": body_snippet,
            "body_full": body_full,
            "is_read": False,
            "attachments": attachments
        }
    except Exception as e:
        logger.error(f"Error parsing message: {e}")
        return None

async def send_gmail_reply(credentials_dict: Dict[str, Any], thread_id: str, to: str, subject: str, body: str):
    """Sends a reply to a thread using real Gmail API."""
    service = get_gmail_service(credentials_dict)
    if not service:
        raise Exception("Could not initialize Gmail client.")
        
    try:
        from email.mime.text import MIMEText
        # Ensure subject starts with Re:
        if not subject.lower().startswith("re:"):
            subject = f"Re: {subject}"
            
        message = MIMEText(body)
        message['to'] = to
        message['subject'] = subject
        message['threadId'] = thread_id
        
        raw_msg = base64.urlsafe_b64encode(message.as_bytes()).decode('utf-8')
        send_result = service.users().messages().send(userId='me', body={'raw': raw_msg, 'threadId': thread_id}).execute()
        return send_result
    except Exception as e:
        logger.error(f"Gmail reply failed: {e}")
        raise e

def generate_mock_emails(user_email: str) -> List[Dict[str, Any]]:
    """No simulated emails for live production use."""
    return []
