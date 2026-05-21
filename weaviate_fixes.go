/*
 * weaviate/weaviate — 16k stars, Go vector database.
 * #2496 — Return vectorized query with results
 * #2567 — Keyword highlighting in search results
 */

// ═══════════════════════════════════════════════════════════════════════════
// #2496 — Return vectorized query with results
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Add `_additional.queryVector` to GraphQL response.
 * Returns the vectorized query once at the top level (not per-result).
 *
 * Files:
 *   adapters/handlers/graphql/local/get/get.go — add queryVector to response
 *   usecases/traverser/traverser.go — pass query vector through traverser
 *   entities/schema/additional.go — register queryVector as valid additional prop
 */

// ── 1. Register the additional property ─────────────────────────────────

// In entities/schema/additional.go:
var AdditionalProperties = map[string]bool{
    "vector":        true,
    "distance":      true,
    "certainty":     true,
    "id":            true,
    "queryVector":   true,  // NEW
    "highlight":     true,  // for #2567
    // ... existing
}

// ── 2. Pass query vector through the traverser ──────────────────────────

// In usecases/traverser/traverser.go:
type GetParams struct {
    SearchVector    []float32
    QueryVector     []float32  // NEW: the original vectorized query
    // ... existing fields
}

func (t *Traverser) Get(params GetParams) ([]*search.Result, error) {
    // ... existing search logic

    // Attach query vector to each result for GraphQL layer to extract
    for _, res := range results {
        res.QueryVector = params.QueryVector
    }

    return results, nil
}

// ── 3. GraphQL resolver: add queryVector to response ────────────────────

// In adapters/handlers/graphql/local/get/get.go:
func (r *Resolver) resolveGet(ctx context.Context, p graphql.ResolveParams) (interface{}, error) {
    // ... existing resolution logic

    // Check if queryVector was requested in _additional
    additional := extractAdditionalProperties(p)
    includeQueryVector := additional["queryVector"]

    if includeQueryVector {
        // Return query vector globally (once), not per result
        // The first result carries the query vector; extract it once
        if len(results) > 0 && results[0].QueryVector != nil {
            return map[string]interface{}{
                "results":     formattedResults,
                "queryVector": results[0].QueryVector,
            }, nil
        }
    }

    return map[string]interface{}{
        "results": formattedResults,
    }, nil
}

// ── 4. GraphQL schema update ────────────────────────────────────────────

/*
In the GraphQL schema definition, add queryVector to GetObj:

type GetObj {
    results: [Result!]!
    queryVector: [Float!]  # NEW: vectorized query, returned globally
}
*/


// ═══════════════════════════════════════════════════════════════════════════
// #2567 — Keyword highlighting in search results
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Add `_additional.highlight` field that returns keyword-matching
 * snippets from the text with <mark> tags around matched terms.
 * Similar to Solr/Elasticsearch highlighting.
 *
 * For BM25/keyword search: highlight matched terms in the text.
 * For vector/"Ask" search: highlight based on query-analysis extracted keywords.
 *
 * Files:
 *   adapters/handlers/graphql/local/get/get.go — add highlight resolution
 *   usecases/traverser/highlight.go — NEW: highlight logic
 *   entities/search/result.go — add Highlight field to Result
 */

// ── 1. Highlight struct ─────────────────────────────────────────────────

package search

type Highlight struct {
    Property string   `json:"property"`
    Snippets []string `json:"snippets"` // HTML snippets with <mark> tags
}

type Result struct {
    // ... existing fields
    Highlight []Highlight `json:"_additional.highlight,omitempty"` // NEW
}

// ── 2. Highlight logic ──────────────────────────────────────────────────

package traverser

import (
    "regexp"
    "strings"
    "unicode/utf8"
)

const (
    maxSnippetLen   = 200  // characters per snippet
    snippetContext  = 50   // characters before/after match
    maxSnippets     = 3    // max snippets per property
)

var htmlTags = regexp.MustCompile(`<[^>]*>`)

func GenerateHighlight(text string, keywords []string) []string {
    if len(keywords) == 0 || text == "" {
        return nil
    }

    // Strip existing HTML tags for clean matching
    cleanText := htmlTags.ReplaceAllString(text, "")

    // Find all keyword positions
    lowerText := strings.ToLower(cleanText)
    var matches []matchPos
    for _, kw := range keywords {
        lowerKW := strings.ToLower(kw)
        start := 0
        for {
            idx := strings.Index(lowerText[start:], lowerKW)
            if idx < 0 {
                break
            }
            absIdx := start + idx
            matches = append(matches, matchPos{absIdx, absIdx + len(kw)})
            start = absIdx + len(kw)
        }
    }

    if len(matches) == 0 {
        return nil
    }

    // Merge overlapping matches
    merged := mergeMatches(matches)

    // Generate snippets around first N matches
    snippets := make([]string, 0, maxSnippets)
    for i, m := range merged {
        if i >= maxSnippets {
            break
        }

        start := max(0, m.start-snippetContext)
        end := min(len(cleanText), m.end+snippetContext)

        // Align to word boundaries
        for start > 0 && cleanText[start] != ' ' {
            start--
        }
        for end < len(cleanText) && cleanText[end] != ' ' {
            end++
        }

        snippet := cleanText[start:end]

        // Apply highlighting: wrap matched terms in <mark>
        for _, m2 := range merged {
            kw := strings.ToLower(cleanText[m2.start:m2.end])
            // Find all case-insensitive occurrences of kw in snippet
            re := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(kw))
            snippet = re.ReplaceAllStringFunc(snippet, func(s string) string {
                return "<mark>" + s + "</mark>"
            })
        }

        // Add ellipsis
        prefix := ""
        suffix := ""
        if start > 0 {
            prefix = "..."
        }
        if end < len(cleanText) {
            suffix = "..."
        }
        snippet = prefix + snippet + suffix

        snippets = append(snippets, snippet)
    }

    return snippets
}

type matchPos struct{ start, end int }

func mergeMatches(matches []matchPos) []matchPos {
    if len(matches) <= 1 {
        return matches
    }
    // Sort by start position
    sorted := make([]matchPos, len(matches))
    copy(sorted, matches)
    // Simple sort (production code would use sort.Slice)
    for i := 0; i < len(sorted); i++ {
        for j := i + 1; j < len(sorted); j++ {
            if sorted[j].start < sorted[i].start {
                sorted[i], sorted[j] = sorted[j], sorted[i]
            }
        }
    }

    merged := []matchPos{sorted[0]}
    for _, m := range sorted[1:] {
        last := &merged[len(merged)-1]
        if m.start <= last.end {
            if m.end > last.end {
                last.end = m.end
            }
        } else {
            merged = append(merged, m)
        }
    }
    return merged
}

// ── 3. Integrate into GraphQL response ──────────────────────────────────

// In get.go resolver:
func resolveAdditionalHighlight(params GetParams, result *search.Result) {
    if !params.AdditionalProperties["highlight"] {
        return
    }

    keywords := params.HighlightKeywords
    if len(keywords) == 0 {
        // Extract keywords from query for "Ask" mode
        keywords = extractKeywordsFromQuery(params.Query)
    }

    // Generate highlights for each text property in the schema
    schema := result.Object().Class().Properties()
    for _, prop := range schema {
        if prop.DataType[0] != "text" && prop.DataType[0] != "string" {
            continue
        }
        value, ok := result.Object().Get(prop.Name)
        if !ok || value == nil {
            continue
        }
        text, ok := value.(string)
        if !ok {
            continue
        }

        snippets := GenerateHighlight(text, keywords)
        if len(snippets) > 0 {
            result.Highlight = append(result.Highlight, search.Highlight{
                Property: prop.Name,
                Snippets: snippets,
            })
        }
    }
}

// ── 4. GraphQL query example ────────────────────────────────────────────

/*
{
  Get {
    Article(nearText: {concepts: ["vector databases"]}) {
      title
      content
      _additional {
        id
        distance
        queryVector       # from #2496
        highlight {        # from #2567
          property
          snippets
        }
      }
    }
  }
}

// Response:
{
  "data": {
    "Get": {
      "Article": [
        {
          "title": "Introduction to Weaviate",
          "content": "Weaviate is an open-source <mark>vector</mark> <mark>database</mark>...",
          "_additional": {
            "id": "abc-123",
            "distance": 0.12,
            "highlight": [
              {
                "property": "content",
                "snippets": ["...open-source <mark>vector</mark> <mark>database</mark> that stores..."]
              }
            ]
          }
        }
      ],
      "queryVector": [0.12, -0.34, 0.56, ...]
    }
  }
}
*/
