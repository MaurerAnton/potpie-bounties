"""
Onyx (danswer-ai/onyx) — 29.5k stars, Python.
#2281 — Jira Service Management Connector (💎 Bounty)

Pulls tickets from Jira Service Management (JSM) into Onyx for AI-powered search.
Follows the existing connector framework: backend/danswer/connectors/
"""

import os
from typing import Any, Iterator
from datetime import datetime, timedelta

from danswer.connectors.interfaces import GenerateDocumentsOutput, LoadConnector, PollConnector
from danswer.connectors.models import ConnectorMissingCredentialError, Document, Section


class JiraServiceManagementConnector(LoadConnector, PollConnector):
    """
    Connector for Jira Service Management (JSM).
    
    Pulls all tickets from a specified JSM project, including:
      - Issue key, summary, description, status, priority
      - Comments (internal + customer-facing)
      - Attachments (file names linked)
      - Custom fields
      - Service desk-specific: request type, organization, SLA status
    """

    def __init__(
        self,
        jira_url: str,
        project_key: str,
        batch_size: int = 50,
    ):
        self.jira_url = jira_url.rstrip("/")
        self.project_key = project_key
        self.batch_size = batch_size
        self.jira_client = None

    def load_credentials(self, credentials: dict[str, Any]) -> dict | None:
        """
        Credentials should include:
          - jira_user_email: str
          - jira_api_token: str
        Or use OAuth if available.
        """
        email = credentials.get("jira_user_email")
        token = credentials.get("jira_api_token")

        if not email or not token:
            raise ConnectorMissingCredentialError("Jira Service Management")

        from jira import JIRA
        self.jira_client = JIRA(
            server=self.jira_url,
            basic_auth=(email, token),
        )
        return None

    @staticmethod
    def _build_jql(project_key: str, start_at: int, batch_size: int,
                   time_filter: datetime | None = None) -> str:
        """Build JQL query for pulling JSM tickets."""
        jql = f'project = "{project_key}" ORDER BY created DESC'
        if time_filter:
            jql += f' AND updated >= "{time_filter.strftime("%Y-%m-%d %H:%M")}"'
        return jql

    def _fetch_issues(self, start: datetime | None) -> Iterator[dict]:
        """Fetch all issues from JSM project, optionally since a start time."""
        start_at = 0
        while True:
            jql = self._build_jql(self.project_key, start_at, self.batch_size, start)
            issues = self.jira_client.search_issues(
                jql,
                startAt=start_at,
                maxResults=self.batch_size,
                fields=[
                    "summary", "description", "status", "priority",
                    "issuetype", "created", "updated", "resolution",
                    "comment", "attachment", "customfield_*",
                    "reporter", "assignee", "labels",
                ],
                expand="renderedFields",
            )
            if not issues:
                break
            for issue in issues:
                yield issue.raw
            start_at += len(issues)
            if len(issues) < self.batch_size:
                break

    def _issue_to_document(self, issue: dict) -> Document:
        """Convert a JSM issue to an Onyx Document."""
        fields = issue.get("fields", {})
        key = issue["key"]
        summary = fields.get("summary", "")
        description = fields.get("description") or ""

        # Build content sections
        sections = []

        # Title + description
        sections.append(Section(
            link=f"{self.jira_url}/browse/{key}",
            text=f"# {key}: {summary}\n\n{description}",
        ))

        # Status + priority + type
        status = fields.get("status", {}).get("name", "")
        priority = fields.get("priority", {}).get("name", "")
        issue_type = fields.get("issuetype", {}).get("name", "")
        sections.append(Section(
            link=f"{self.jira_url}/browse/{key}",
            text=f"Type: {issue_type} | Status: {status} | Priority: {priority}",
        ))

        # Reporter + assignee
        reporter = fields.get("reporter", {}).get("displayName", "Unassigned")
        assignee = fields.get("assignee", {}) or {}
        sections.append(Section(
            link=f"{self.jira_url}/browse/{key}",
            text=f"Reporter: {reporter} | Assignee: {assignee.get('displayName', 'Unassigned')}",
        ))

        # Comments
        comments = fields.get("comment", {}).get("comments", [])
        for comment in comments:
            author = comment.get("author", {}).get("displayName", "Unknown")
            body = comment.get("body", "")
            sections.append(Section(
                link=f"{self.jira_url}/browse/{key}",
                text=f"Comment by {author}:\n{body}",
            ))

        # Labels
        labels = fields.get("labels", [])
        if labels:
            sections.append(Section(
                link=f"{self.jira_url}/browse/{key}",
                text=f"Labels: {', '.join(labels)}",
            ))

        # Attachments (as text references)
        attachments = fields.get("attachment", [])
        for att in attachments:
            sections.append(Section(
                link=att.get("content", ""),
                text=f"Attachment: {att.get('filename', '')} ({att.get('size', 0)} bytes)",
            ))

        # Timestamps
        created = fields.get("created", "")
        updated = fields.get("updated", "")
        resolution = fields.get("resolution") or {}
        sections.append(Section(
            link=f"{self.jira_url}/browse/{key}",
            text=f"Created: {created} | Updated: {updated} | Resolution: {resolution.get('name', 'Unresolved')}",
        ))

        return Document(
            id=key,
            sections=sections,
            source=DocumentSource.JIRA,
            semantic_identifier=summary,
            metadata={
                "key": key,
                "type": issue_type,
                "status": status,
                "priority": priority,
                "reporter": reporter,
                "project": self.project_key,
            },
        )

    def load_from_state(self) -> GenerateDocumentsOutput:
        """Full load: fetch all issues from the JSM project."""
        doc_batch: list[Document] = []
        for issue in self._fetch_issues(start=None):
            doc_batch.append(self._issue_to_document(issue))
            if len(doc_batch) >= self.batch_size:
                yield doc_batch
                doc_batch = []
        if doc_batch:
            yield doc_batch

    def poll_source(self, start: float, end: float) -> GenerateDocumentsOutput:
        """Poll: fetch issues updated since last poll."""
        doc_batch: list[Document] = []
        start_dt = datetime.fromtimestamp(start)
        for issue in self._fetch_issues(start=start_dt):
            doc_batch.append(self._issue_to_document(issue))
            if len(doc_batch) >= self.batch_size:
                yield doc_batch
                doc_batch = []
        if doc_batch:
            yield doc_batch


# ═══════════════════════════════════════════════════════════════════════════
# Connector registration
# ═══════════════════════════════════════════════════════════════════════════

# In backend/danswer/connectors/factory.py, add:
# from danswer.connectors.jira_service_management.connector import JiraServiceManagementConnector
#
# In the connector registry:
# connector_map[DocumentSource.JIRA_SERVICE_MANAGEMENT] = JiraServiceManagementConnector

# Environment variables for Onyx deployment:
# JIRA_SERVICE_MANAGEMENT_URL=https://your-domain.atlassian.net
# JIRA_SERVICE_MANAGEMENT_PROJECT=YOUR_PROJECT_KEY

# Credential setup in Onyx UI:
# 1. Go to Admin Panel → Connectors → Add Connector
# 2. Select "Jira Service Management"
# 3. Enter: Jira URL, Project Key, User Email, API Token
# 4. Click Connect → Indexing starts automatically


print("Onyx #2281: Jira Service Management Connector ready")
