---
name: cao-codebase-memory
description: Query one combined fleet-wide Codebase Memory graph through cao-mcp-server
---

# CAO Fleet Codebase Memory

Use `codebase_*` tools from `cao-mcp-server`; never configure raw `codebase-memory-mcp` in an agent profile.

1. Call `codebase_projects` or `codebase_status` to resolve logical project and node freshness.
2. For structural questions, use `codebase_search_graph`, then `codebase_trace_path` or `codebase_get_code_snippet`.
3. Inspect `source_node`, `dirty`, `head_sha`, `diverged`, and every returned variant. Do not silently select one machine.
4. Call `codebase_check_index_coverage` for cited paths. Partial coverage requires direct local source inspection.
5. Before editing, read the local working-tree file. Indexed source is evidence; local editable source is authoritative.

Fleet queries never synchronize, merge, upload, or overwrite working trees. Repository paths can differ across machines because Git remote identity groups projects.
