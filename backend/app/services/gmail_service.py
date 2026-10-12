import time
import random
from typing import List, Dict, Any, Optional
from app.config import settings
from app.models.schemas import EmailItem, CategoryEnum, PriorityEnum, EmailSummary, ActionItem, AttachmentInfo
from app.database.db import db
from app.services.gemini_service import gemini_service

class GmailService:
    @property
    def client_id(self):
        return settings.GOOGLE_CLIENT_ID

    @property
    def client_secret(self):
        return settings.GOOGLE_CLIENT_SECRET

    @property
    def redirect_uri(self):
        return settings.GOOGLE_REDIRECT_URI

    def get_oauth_url(self) -> str:
        """Returns Google OAuth 2.0 authorization URL."""
        if not self.client_id:
            # Return demo callback URL
            return f"{settings.FRONTEND_URL}/login?demo_auth=true"
        
        scopes = [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/userinfo.profile"
        ]
        scope_str = "%20".join(scopes)
        return (
            f"https://accounts.google.com/o/oauth2/v2/auth?"
            f"client_id={self.client_id}&"
            f"redirect_uri={self.redirect_uri}&"
            f"response_type=code&"
            f"scope={scope_str}&"
            f"access_type=offline&"
            f"prompt=consent"
        )

    async def sync_inbox(self, user_email: str = "user@gmail.com", user_name: str = "", credentials_dict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Runs real-time email sync engine for the logged-in user."""
        clean_user = (user_email or "user@gmail.com").strip().lower()
        added_count = 0

        # Retrieve credentials from argument or DB cache
        creds = credentials_dict or db.get_user_credentials(clean_user)

        if not creds:
            return {
                "status": "disconnected",
                "synced_emails_count": 0,
                "total_user_emails": len(db.get_emails(folder="all", user_email=clean_user)),
                "message": "Gmail is not connected. Sign in with Google again.",
            }

        # Remove records from older demo builds before any live fetch, including
        # when the mailbox is empty or Gmail returns an error.
        db.clear_fake_emails_for_user(clean_user)
        try:
            from app.services.gmail import fetch_emails_from_gmail
            raw_emails = await fetch_emails_from_gmail(clean_user, creds)
            for raw in raw_emails:
                email_id = raw["_id"]
                if email_id in db.emails:
                    continue
                analysis = await gemini_service.analyze_and_summarize_email(
                    raw["subject"], raw["body_full"], raw["sender_name"]
                )
                raw_date = raw.get("date")
                if hasattr(raw_date, "strftime"):
                    date_str = raw_date.strftime("%b %d, %H:%M")
                    ts = raw_date.timestamp()
                else:
                    date_str = time.strftime("%b %d, %H:%M")
                    ts = time.time()

                email = EmailItem(
                    id=email_id,
                    sender_name=raw["sender_name"],
                    sender_email=raw["sender_email"],
                    recipient_email=clean_user,
                    subject=raw["subject"],
                    snippet=raw["body_snippet"][:160] if raw.get("body_snippet") else raw["subject"],
                    body=raw["body_full"],
                    category=analysis.get("category", CategoryEnum.WORK),
                    priority=analysis.get("priority", PriorityEnum.MEDIUM),
                    date=date_str,
                    timestamp=ts,
                    is_read=raw.get("is_read", False),
                    is_starred=raw.get("is_starred", False),
                    summary=EmailSummary(
                        bullet_points=analysis.get("bullet_points", []),
                        one_liner=analysis.get("one_liner", ""),
                        urgency_reason=analysis.get("urgency_reason"),
                        sentiment=analysis.get("sentiment", "Neutral"),
                        key_deadlines=analysis.get("deadlines", [])
                    ),
                    action_items=[
                        ActionItem(task=item.get("task", ""), due_date=item.get("due_date"))
                        for item in analysis.get("action_items", [])
                    ],
                    folder=raw.get("folder", "inbox")
                )
                db.add_email(email)
                added_count += 1
        except Exception as e:
            return {
                "status": "error",
                "synced_emails_count": 0,
                "total_user_emails": len(db.get_emails(folder="all", user_email=clean_user)),
                "message": str(e),
            }

        # Never fabricate mailbox contents for a live account. An empty Gmail
        # result is a valid mailbox state and must remain empty.

        total_now = len(db.get_emails(folder="all", user_email=clean_user))
        return {
            "status": "success",
            "synced_emails_count": added_count,
            "total_user_emails": total_now,
            "message": f"Inbox synchronized successfully! {added_count} new messages loaded."
        }

    def generate_user_inbox_emails(self, user_email: str, user_name: str) -> List[EmailItem]:
        """Generates real-time, user-personalized inbox emails with rich AI metadata."""
        now = time.time()
        
        emails = [
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="Marcus Vance (CEO)",
                sender_email="ceo@techcorp-exec.com",
                recipient_email=user_email,
                subject="URGENT: Q3 Executive Roadmap Alignment & AI Assistant Status",
                snippet=f"Hi {user_name}, I need an urgent progress update on our smart email assistant project before our board meeting tomorrow morning...",
                body=f"""Hi {user_name},

I need an urgent update on the Smart Email project release status before our board meeting tomorrow morning.
Specifically, I would like to know:
1. Is the Google OAuth 2.0 flow and user email sync fully verified?
2. What is the current token consumption rate for Gemini AI summaries?
3. Are all mobile view templates and dark mode widgets responsive?

Please submit a detailed progress report to my office tomorrow by 9:00 AM.
Also, let's schedule an executive sync meeting tomorrow at 4:00 PM in the boardroom to discuss budget extensions.

Best regards,
Marcus Vance
Chief Executive Officer""",
                category=CategoryEnum.WORK,
                priority=PriorityEnum.HIGH,
                date="1 hr ago",
                timestamp=now - 3600,
                is_read=False,
                is_starred=True,
                folder="inbox",
                summary=EmailSummary(
                    bullet_points=[
                        "CEO requesting urgent progress report on Smart Email Assistant before board meeting",
                        "Report submission required by 9:00 AM tomorrow",
                        "Executive alignment meeting scheduled for 4:00 PM in executive boardroom"
                    ],
                    one_liner=f"Urgent board meeting update requested from CEO for tomorrow morning.",
                    urgency_reason="CEO board meeting deadline tomorrow morning",
                    sentiment="Urgent",
                    key_deadlines=["Tomorrow 9:00 AM", "Tomorrow 4:00 PM"]
                ),
                action_items=[
                    ActionItem(task="Submit progress report to CEO office", due_date="Tomorrow 9:00 AM", completed=False),
                    ActionItem(task="Executive sync meeting in boardroom", due_date="Tomorrow 4:00 PM", completed=False, is_meeting=True, meeting_time="4:00 PM")
                ]
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="Sarah Jenkins (VP Engineering)",
                sender_email="sarah.jenkins@techcorp.io",
                recipient_email=user_email,
                subject="Technical Architecture Specification & API Integration Docs",
                snippet=f"Hi {user_name}, attached is the technical specification document for our upcoming Q3 API integration...",
                body=f"""Hi {user_name},

Attached is the technical architecture specification document for our Q3 microservices integration.
Please review the system sequence diagram and database indexing strategy.

Key highlights:
- REST API endpoint response times optimized under 150ms
- OAuth 2.0 Bearer Token authorization middleware with auto-refresh
- Gemini Pro Generative AI token caching layer

Let me know if you have any questions before our sprint review on Friday.

Best,
Sarah Jenkins
VP of Engineering""",
                category=CategoryEnum.WORK,
                priority=PriorityEnum.HIGH,
                date="3 hrs ago",
                timestamp=now - 10800,
                is_read=False,
                is_starred=False,
                has_attachments=True,
                folder="inbox",
                attachments=[
                    AttachmentInfo(
                        id="att-arch-01",
                        filename="Q3_Technical_Architecture_Spec.pdf",
                        size="2.4 MB",
                        content_type="application/pdf"
                    )
                ],
                summary=EmailSummary(
                    bullet_points=[
                        "Technical architecture spec attached for Q3 API integration",
                        "Highlights <150ms API latencies, OAuth 2.0 auth middleware, and Gemini AI token caching",
                        "Feedback requested before Friday sprint review"
                    ],
                    one_liner="VP Engineering shared Q3 architecture spec PDF for technical review.",
                    sentiment="Positive",
                    key_deadlines=["Friday Sprint Review"]
                ),
                action_items=[
                    ActionItem(task="Review architecture PDF specification document", due_date="Friday", completed=False)
                ]
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="GitHub Notifications",
                sender_email="notifications@github.com",
                recipient_email=user_email,
                subject="[PR Merged] #142 Implement OAuth2 & Gemini Pro Summarizer API",
                snippet=f"Pull request #142 'Implement OAuth2 & Gemini Pro Summarizer API' was successfully merged into main branch...",
                body=f"""Hello {user_name},

Pull Request #142 [Implement OAuth2 & Gemini Pro Summarizer API] has been approved and merged into main branch by sarah-jenkins.

Summary of changes:
- Integrated FastAPI async background task queue for email processing
- Added Pydantic schema validation for EmailItem and AISummary models
- 100% unit test coverage for authentication middleware

View PR: https://github.com/techcorp/smart-email-assistant/pull/142""",
                category=CategoryEnum.WORK,
                priority=PriorityEnum.HIGH,
                date="4 hrs ago",
                timestamp=now - 14400,
                is_read=False,
                is_starred=True,
                folder="inbox",
                summary=EmailSummary(
                    bullet_points=[
                        "PR #142 merged into main branch by Sarah Jenkins",
                        "Includes OAuth2, Gemini Pro summarizer API, and FastAPI async tasks",
                        "All unit tests passing with 100% coverage"
                    ],
                    one_liner="GitHub PR #142 merged into main branch.",
                    sentiment="Positive"
                ),
                action_items=[
                    ActionItem(task="Pull latest main branch and verify local build", due_date="Today", completed=False)
                ]
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="Security Center",
                sender_email="no-reply@security-alerts.io",
                recipient_email=user_email,
                subject=f"Security Notice: New session login for {user_email}",
                snippet=f"Hello {user_name}, your account {user_email} was successfully logged into from Chrome on Windows...",
                body=f"""Hello {user_name},

Your AI Email Assistant account ({user_email}) was accessed from a new device session:
- Browser: Google Chrome
- Operating System: Windows
- Session Time: {time.strftime('%b %d, %Y %H:%M:%S UTC')}

If this was you, no further action is required. If you did not initiate this login, please change your security credentials immediately.

Security Operations Team""",
                category=CategoryEnum.UPDATES,
                priority=PriorityEnum.MEDIUM,
                date="5 hrs ago",
                timestamp=now - 18000,
                is_read=True,
                folder="inbox",
                summary=EmailSummary(
                    bullet_points=[
                        f"Login activity detected for {user_email}",
                        "Client: Chrome on Windows",
                        "No action needed if initiated by account holder"
                    ],
                    one_liner=f"Security login notification for {user_email}.",
                    sentiment="Neutral"
                )
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="Emily Zhao (Legal Lead)",
                sender_email="emily.zhao@lexislegal.com",
                recipient_email=user_email,
                subject="Updated Master Services Agreement & Data Privacy Addendum",
                snippet=f"Hi {user_name}, please review the updated Data Privacy Addendum for compliance with EU AI Act regulations...",
                body=f"""Hi {user_name},

Our legal team has finalized the updated Master Services Agreement (MSA) and Data Privacy Addendum to align with the new EU AI Act and GDPR compliance guidelines.

Please review the attached document and provide your electronic signature by Wednesday end of day.

Attached:
- MSA_Privacy_Addendum_2026.pdf (1.8 MB)

Best regards,
Emily Zhao
Senior Legal Counsel""",
                category=CategoryEnum.WORK,
                priority=PriorityEnum.MEDIUM,
                date="7 hrs ago",
                timestamp=now - 25200,
                is_read=False,
                is_starred=False,
                has_attachments=True,
                folder="inbox",
                attachments=[
                    AttachmentInfo(
                        id="att-legal-01",
                        filename="MSA_Privacy_Addendum_2026.pdf",
                        size="1.8 MB",
                        content_type="application/pdf"
                    )
                ],
                summary=EmailSummary(
                    bullet_points=[
                        "Legal team finalized updated MSA & Data Privacy Addendum for GDPR/EU AI Act",
                        "Electronic signature requested by Wednesday EOD"
                    ],
                    one_liner="Legal lead sent updated MSA & Data Privacy Addendum PDF for signature.",
                    sentiment="Neutral",
                    key_deadlines=["Wednesday EOD"]
                ),
                action_items=[
                    ActionItem(task="Sign updated MSA and Privacy Addendum PDF", due_date="Wednesday EOD", completed=False)
                ]
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="Stripe Billing",
                sender_email="invoices@stripe.com",
                recipient_email=user_email,
                subject="Receipt for Invoice #INV-2026-9840 - Smart Email Pro",
                snippet=f"Hi {user_name}, your payment of $29.00 for Smart Email Pro subscription was successful...",
                body=f"""Hi {user_name},

Thank you for your business! Your payment for Smart Email Pro subscription has been processed.

Invoice Number: INV-2026-9840
Amount Paid: $29.00 USD
Billed To: {user_email}
Payment Method: Visa ending in 4092

You can view your full transaction history and download tax invoices anytime in your settings panel.

Stripe Billing Team""",
                category=CategoryEnum.FINANCE,
                priority=PriorityEnum.LOW,
                date="Yesterday",
                timestamp=now - 86400,
                is_read=True,
                folder="inbox",
                summary=EmailSummary(
                    bullet_points=[
                        "Payment of $29.00 processed for Smart Email Pro subscription",
                        "Invoice #INV-2026-9840 billing receipt confirmed"
                    ],
                    one_liner="Receipt for $29.00 SaaS subscription payment.",
                    sentiment="Neutral"
                )
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="Google Cloud Platform",
                sender_email="no-reply@cloud.google.com",
                recipient_email=user_email,
                subject="Monthly Cloud Billing & AI API Usage Summary for September",
                snippet=f"Hi {user_name}, your September cloud usage report is available. Total spend: $142.50 across Vertex AI and Gemini API...",
                body=f"""Hi {user_name},

Your monthly Google Cloud usage summary for project 'smart-email-assistant-prod' is now available.

Account summary:
- Gemini API Requests: 45,210 tokens processed
- Cloud Run Services: $48.20
- Supabase Vector Storage: $18.30
- Total Invoice Amount: $142.50 USD (Auto-debited on Oct 1)

View detailed billing metrics in your GCP Console.

Google Cloud Billing Team""",
                category=CategoryEnum.FINANCE,
                priority=PriorityEnum.MEDIUM,
                date="Yesterday",
                timestamp=now - 88000,
                is_read=True,
                folder="inbox",
                summary=EmailSummary(
                    bullet_points=[
                        "GCP monthly billing summary: $142.50 total spend",
                        "Gemini API tokens processed: 45,210 tokens",
                        "Auto-debit scheduled for Oct 1"
                    ],
                    one_liner="Google Cloud monthly billing report ($142.50).",
                    sentiment="Neutral"
                )
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="Amazon Logistics",
                sender_email="shipment-tracking@amazon.com",
                recipient_email=user_email,
                subject="Your Amazon package has been delivered!",
                snippet=f"Hello {user_name}, your order containing 'Mechanical Keyboard & USB-C Desk Dock' was delivered...",
                body=f"""Hello {user_name},

Your package containing 'Tactile Mechanical Keyboard' and 'USB-C Multiport Desk Dock' has been delivered to your front door!

Carrier: UPS Express
Tracking Number: 1Z999AA10482019
Delivery Location: Front Door / Porch

We hope you enjoy your purchase!

Amazon Logistics""",
                category=CategoryEnum.UPDATES,
                priority=PriorityEnum.LOW,
                date="Yesterday",
                timestamp=now - 90000,
                is_read=True,
                folder="inbox",
                summary=EmailSummary(
                    bullet_points=[
                        "Package containing Mechanical Keyboard & Desk Dock delivered",
                        "Delivered by UPS Express to Front Door"
                    ],
                    one_liner="Amazon order delivery confirmation.",
                    sentiment="Positive"
                )
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="David Miller (Product Manager)",
                sender_email="david.miller@techcorp.io",
                recipient_email=user_email,
                subject="Design Review: User Interface & Dark Mode Feedback",
                snippet=f"Hi {user_name}, the product team reviewed the latest UI builds. Dark mode and glassmorphism styling look fantastic...",
                body=f"""Hi {user_name},

Great job on the latest UI iteration! The dark mode styling, responsive typography, and instant voice assistant modal received high praise during our design critique today.

A few minor polish requests:
1. Ensure email list action buttons (star, delete, unread) have subtle hover highlights in dark mode.
2. Add micro-animation when AI summary modal opens.

Let me know when the updated build is deployed to staging.

Cheers,
David Miller""",
                category=CategoryEnum.WORK,
                priority=PriorityEnum.MEDIUM,
                date="2 days ago",
                timestamp=now - 160000,
                is_read=True,
                is_starred=True,
                folder="inbox",
                summary=EmailSummary(
                    bullet_points=[
                        "Product team praised UI dark mode and design polish",
                        "Feedback items: dark mode hover effects & modal micro-animations"
                    ],
                    one_liner="Product Manager shared positive UI design review feedback.",
                    sentiment="Positive"
                )
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="TechDeals Global",
                sender_email="promos@techdeals-weekly.com",
                recipient_email=user_email,
                subject="⚡ 40% OFF Cloud Infrastructure & AI Developer Suite",
                snippet=f"Special offer for {user_email}: Unlock 40% discount on cloud AI instances and developer tooling...",
                body=f"""Exclusive Developer Deal for {user_email}!

For the next 24 hours only, get 40% off all Cloud AI compute instances, vector databases, and LLM hosting.
Use promo code: DEVAI40 at checkout.

Upgrade your deployment pipeline and scale your intelligent applications effortlessly!

TechDeals Team""",
                category=CategoryEnum.PROMOTIONS,
                priority=PriorityEnum.LOW,
                date="2 days ago",
                timestamp=now - 172800,
                is_read=True,
                folder="inbox",
                summary=EmailSummary(
                    bullet_points=[
                        "40% promo code DEVAI40 for cloud AI compute & databases",
                        "Valid for 24 hours"
                    ],
                    one_liner="Promotional discount on AI cloud hosting.",
                    sentiment="Neutral"
                )
            ),
            EmailItem(
                id=f"em-usr-{random.randint(10000, 99999)}",
                sender_name="Security Alert Team",
                sender_email="support@amaz0n-security-update.xyz",
                recipient_email=user_email,
                subject="URGENT SECURITY: Account Suspended - Verify Password Immediately!",
                snippet=f"Dear {user_email}, we detected unauthorized access. Verify your login credentials within 2 hours...",
                body=f"""DEAR USER ({user_email}),

WE DETECTED UNAUTHORIZED LOGINS ON YOUR ACCOUNT FROM AN UNKNOWN LOCATION.
YOUR ACCOUNT WILL BE PERMANENTLY SUSPENDED WITHIN 2 HOURS UNLESS YOU VERIFY YOUR SECURITY PASSWORD IMMEDIATELY.

CLICK HERE TO VERIFY YOUR PASSWORD: http://amaz0n-security-update.xyz/verify-login

Account Protection Center""",
                category=CategoryEnum.SPAM,
                priority=PriorityEnum.LOW,
                date="3 days ago",
                timestamp=now - 259200,
                is_read=False,
                is_spam=True,
                folder="spam",
                summary=EmailSummary(
                    bullet_points=[
                        "Phishing attempt detected using fake domain 'amaz0n-security-update.xyz'",
                        "Urgent password verification scam"
                    ],
                    one_liner="Suspicious phishing scam flagged and isolated to Spam folder.",
                    urgency_reason="Fake phishing deadline threat",
                    sentiment="Urgent"
                )
            )
        ]
        
        return emails

gmail_service = GmailService()
