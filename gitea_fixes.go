/*
 * go-gitea/gitea — 2 bounties (56k stars, Go).
 * #4898 — Inline comments on commits
 * #1872 — Subgroups in Gitea ($250)
 */

// ═══════════════════════════════════════════════════════════════════════════
// #4898 — Add inline comments on commits
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Currently Gitea supports:
 *   - Issue comments
 *   - PR review comments (inline + general)
 *   - Release comments
 *
 * This adds: inline comments on commits (not just PRs).
 * Users can comment on specific lines of a commit diff.
 *
 * Files to create/modify:
 *   1. routers/web/repo/commit_comment.go — new handler
 *   2. services/commit_comment/commit_comment.go — service layer
 *   3. templates/repo/commit_page.tmpl — UI template
 *   4. models/repo/commit_comment.go — DB model (reuses existing comment table)
 */

// ── 1. Model: reuse existing Comment table with a new comment type ──────

package repo

import (
	"code.gitea.io/gitea/models/db"
	"code.gitea.io/gitea/modules/timeutil"
)

// CommentTypeCommitInline is a new comment type for inline commit comments.
const CommentTypeCommitInline CommentType = 23 // next available ID after existing types

// CommitComment extends the existing Comment model.
// We reuse `Comment.Line` and `Comment.TreePath` for inline position,
// and `Comment.CommitSHA` for the target commit.
type CommitComment struct {
	ID          int64  `xorm:"pk autoincr"`
	Type        CommentType
	IssueID     int64  `xorm:"INDEX"` // 0 for commit comments (no issue)
	CommitSHA   string `xorm:"VARCHAR(64) INDEX"`
	PosterID    int64  `xorm:"INDEX"`
	Content     string `xorm:"TEXT"`
	Line        int64  // line number in the commit diff
	TreePath    string `xorm:"VARCHAR(500)"` // file path
	OldLine     int64  // old line number (for moved/deleted lines)
	CreatedUnix timeutil.TimeStamp `xorm:"INDEX created"`
	UpdatedUnix timeutil.TimeStamp `xorm:"INDEX updated"`
}

func (c *CommitComment) TableName() string {
	return "comment" // stored in existing comment table
}

// CreateCommitComment inserts a new inline comment on a commit.
func CreateCommitComment(doer *user_model.User, repoID int64, commitSHA string,
	treePath string, line int64, content string) (*CommitComment, error) {

	comment := &CommitComment{
		Type:        CommentTypeCommitInline,
		PosterID:    doer.ID,
		CommitSHA:   commitSHA,
		Content:     content,
		Line:        line,
		TreePath:    treePath,
		CreatedUnix: timeutil.TimeStampNow(),
		UpdatedUnix: timeutil.TimeStampNow(),
	}

	ctx, committer, err := db.TxContext(db.DefaultContext)
	if err != nil {
		return nil, err
	}
	defer committer.Close()

	if _, err := db.GetEngine(ctx).Insert(comment); err != nil {
		committer.Close()
		return nil, err
	}

	// Handle attachments (uploaded files linked to the comment)
	if err := handleAttachments(ctx, comment.ID, "comment"); err != nil {
		committer.Close()
		return nil, err
	}

	return comment, committer.Commit()
}

// GetCommitComments returns all inline comments for a given commit.
func GetCommitComments(repoID int64, commitSHA string) ([]*CommitComment, error) {
	comments := make([]*CommitComment, 0)
	return comments, db.GetEngine(db.DefaultContext).
		Where("type = ? AND commit_sha = ?", CommentTypeCommitInline, commitSHA).
		OrderBy("created_unix ASC").
		Find(&comments)
}

// ── 2. Router: handle POST /{user}/{repo}/commit/{sha}/comment ──────────

package commit

import (
	"net/http"
	"code.gitea.io/gitea/modules/web"
	"code.gitea.io/gitea/services/context"
)

type CreateCommitCommentForm struct {
	Content  string `form:"content" binding:"Required"`
	TreePath string `form:"tree_path"`
	Line     int64  `form:"line"`
	OldLine  int64  `form:"old_line"`
}

func CreateCommitComment(ctx *context.Context) {
	form := web.GetForm(ctx).(*CreateCommitCommentForm)

	comment, err := repo.CreateCommitComment(
		ctx.Doer,
		ctx.Repo.Repository.ID,
		ctx.Params("sha"),
		form.TreePath,
		form.Line,
		form.Content,
	)
	if err != nil {
		ctx.ServerError("CreateCommitComment", err)
		return
	}

	if ctx.IsAjax() {
		ctx.JSON(http.StatusCreated, map[string]interface{}{
			"id":      comment.ID,
			"content": comment.Content,
			"poster":  ctx.Doer.DisplayName(),
			"created": comment.CreatedUnix.Format("2006-01-02 15:04:05"),
		})
		return
	}

	ctx.Redirect(ctx.Repo.RepoLink + "/commit/" + ctx.Params("sha"))
}

// RegisterRoutes in routers/web/repo/commit.go:
// m.Post("/{sha}/comment", commit.CreateCommitComment)
// m.Get("/{sha}/comments", commit.GetCommitComments)

// ── 3. Template: show inline comments on commit diff page ───────────────

/*
In templates/repo/commit_page.tmpl, add after the diff rendering:

{{if .CommitComments}}
<div class="ui segments commit-comments">
	<h4 class="ui top attached header">{{.locale.Tr "repo.commit.comments"}}</h4>
	<div class="ui attached segment">
		{{range .CommitComments}}
		<div class="comment" id="comment-{{.ID}}">
			<div class="content">
				<div class="metadata">
					<span class="text grey">{{.TreePath}}:{{.Line}}</span>
				</div>
				<a class="author" href="{{.Poster.HomeLink}}">
					<img class="ui avatar image" src="{{.Poster.AvatarLink}}">
					<span>{{.Poster.DisplayName}}</span>
				</a>
				<div class="text">
					{{.Content | RenderMarkdown}}
				</div>
				<div class="actions">
					<span class="text grey">{{TimeSince .CreatedUnix $.locale}}</span>
				</div>
			</div>
		</div>
		{{end}}
	</div>
	<div class="ui bottom attached form">
		<textarea name="content" rows="3" placeholder="{{.locale.Tr "repo.commit.add_comment"}}"></textarea>
		<button class="ui primary button" onclick="submitCommitComment(this)">Comment</button>
	</div>
</div>
{{end}}

<script>
async function submitCommitComment(btn) {
	const form = btn.closest('.form');
	const content = form.querySelector('textarea').value;
	const treePath = '{{.TreePath}}';  // from page context
	const line = {{.Line}};
	const resp = await fetch(window.location.pathname + '/comment', {
		method: 'POST',
		headers: {'Content-Type': 'application/x-www-form-urlencoded'},
		body: new URLSearchParams({content, tree_path: treePath, line: String(line)})
	});
	if (resp.ok) {
		window.location.reload();
	} else {
		alert('Failed to create comment');
	}
}
</script>
*/


// ═══════════════════════════════════════════════════════════════════════════
// #1872 — Subgroups in Gitea ($250)
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Subgroups: allow organizations to have nested sub-organizations.
 * e.g., "acme" → "acme/engineering" → "acme/engineering/backend"
 *
 * This is a major feature touching:
 *   1. Database: add parent_id to organization table
 *   2. Router: handle subgroup paths (/org/suborg/subsuborg)
 *   3. UI: show subgroup tree, breadcrumb navigation
 *   4. Permissions: inherit from parent org
 *   5. API: support subgroup paths
 *
 * Migration:
 *   ALTER TABLE "user" ADD COLUMN "parent_id" BIGINT NULL;
 *   CREATE INDEX "IDX_user_parent_id" ON "user" ("parent_id");
 *   // Organizations are stored in the `user` table with type=1 (organization)
 */

// ── 1. Database migration ──────────────────────────────────────────────

// In models/migrations/v300_add_subgroups.go:
package migrations

import (
	"code.gitea.io/gitea/modules/setting"
	"xorm.io/xorm"
)

func addSubgroups(x *xorm.Engine) error {
	type User struct {
		ID       int64  `xorm:"pk autoincr"`
		ParentID int64  `xorm:"INDEX"`
		FullPath string `xorm:"VARCHAR(512) INDEX"`
	}
	return x.Sync2(new(User))
}

// ── 2. Router: handle subgroup paths ───────────────────────────────────

package org

import (
	"strings"
	"code.gitea.io/gitea/services/context"
)

// ResolveOrgPath parses a path like "acme/engineering/backend"
// and returns the leaf organization.
func ResolveOrgPath(ctx *context.Context) {
	fullPath := ctx.Params("*") // catches everything after /org/
	parts := strings.Split(strings.Trim(fullPath, "/"), "/")

	var parentID int64 = 0
	for i, name := range parts {
		org, err := org_model.GetOrgByName(name)
		if err != nil {
			ctx.NotFound("Organization not found", err)
			return
		}
		if i > 0 && org.ParentID != parentID {
			ctx.NotFound("Invalid subgroup path", nil)
			return
		}
		parentID = org.ID
		if i == len(parts)-1 {
			ctx.Org.Organization = org
		}
	}
}

// Register subgroup routes:
// m.Group("/org/{org:.*}", func() {
//     m.Get("", org.Home)
//     m.Get("/teams", org.Teams)
//     m.Get("/members", org.Members)
//     m.Get("/repositories", org.Repos)
// })

// ── 3. Model: organization with parent ─────────────────────────────────

package org_model

import (
	"code.gitea.io/gitea/models/db"
	user_model "code.gitea.io/gitea/models/user"
)

type Organization struct {
	user_model.User `xorm:"extends"`
	ParentID        int64  `xorm:"INDEX"`
	FullPath        string `xorm:"VARCHAR(512) INDEX"`
}

func (o *Organization) TableName() string {
	return "user"
}

// GetSubgroups returns direct children of this organization.
func (o *Organization) GetSubgroups() ([]*Organization, error) {
	orgs := make([]*Organization, 0)
	return orgs, db.GetEngine(db.DefaultContext).
		Where("type = ? AND parent_id = ?", user_model.UserTypeOrganization, o.ID).
		Find(&orgs)
}

// CreateSubgroup creates a sub-organization under this parent.
func CreateSubgroup(doer *user_model.User, parent *Organization, name string) (*Organization, error) {
	if err := validateOrgName(name); err != nil {
		return nil, err
	}

	subOrg := &Organization{
		User: user_model.User{
			Name:        name,
			LowerName:   strings.ToLower(name),
			Type:        user_model.UserTypeOrganization,
			Visibility:  parent.Visibility,
		},
		ParentID: parent.ID,
		FullPath: parent.FullPath + "/" + strings.ToLower(name),
	}

	ctx, committer, err := db.TxContext(db.DefaultContext)
	if err != nil {
		return nil, err
	}
	defer committer.Close()

	if _, err := db.GetEngine(ctx).Insert(subOrg); err != nil {
		return nil, err
	}

	// Create default teams (Owners, Members) for the subgroup
	if err := CreateDefaultTeams(ctx, subOrg); err != nil {
		return nil, err
	}

	return subOrg, committer.Commit()
}

// ── 4. Permission inheritance ──────────────────────────────────────────

// Subgroup members inherit access from parent organization members.
// Team permissions cascade down the subgroup hierarchy.

func (o *Organization) GetEffectiveMembers() ([]*user_model.User, error) {
	// Get direct members
	members, err := o.GetMembers()
	if err != nil {
		return nil, err
	}

	// Walk up the parent chain and collect parent members
	current := o
	for current.ParentID > 0 {
		parent, err := GetOrgByID(current.ParentID)
		if err != nil {
			break
		}
		parentMembers, err := parent.GetMembers()
		if err != nil {
			break
		}
		members = append(members, parentMembers...)
		current = parent
	}

	return members, nil
}

// ── 5. API endpoint ────────────────────────────────────────────────────

// POST /api/v1/orgs/{org}/subgroups
func CreateSubgroupAPI(ctx *context.APIContext) {
	form := web.GetForm(ctx).(*api.CreateOrgOption)

	subOrg, err := org_model.CreateSubgroup(ctx.Doer, ctx.Org.Organization, form.Name)
	if err != nil {
		ctx.Error(http.StatusInternalServerError, "CreateSubgroup", err)
		return
	}

	ctx.JSON(http.StatusCreated, subOrg.APIFormat())
}

// GET /api/v1/orgs/{org}/subgroups — list subgroups
func ListSubgroupsAPI(ctx *context.APIContext) {
	subgroups, err := ctx.Org.Organization.GetSubgroups()
	if err != nil {
		ctx.Error(http.StatusInternalServerError, "ListSubgroups", err)
		return
	}

	results := make([]*api.Organization, len(subgroups))
	for i, s := range subgroups {
		results[i] = s.APIFormat()
	}
	ctx.JSON(http.StatusOK, results)
}
