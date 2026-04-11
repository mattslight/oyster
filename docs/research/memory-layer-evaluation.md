# Memory Layer Evaluation — March 2026

> **STATUS: Decision made (Graphiti) but deferred to v2.** Current v1 has no persistent memory. The agent is stateless between sessions. See issue #70 for v2 options.

## Context

Oyster needs a persistent knowledge layer so spaces become contextual containers (not just visual folders) and the AI retains context across sessions. The original design doc specifies a nodes + edges knowledge graph in Supabase, but this was deferred during PoC.

## Requirements

- Persistent context scoped per space
- Entity relationships (not just flat facts)
- Temporal awareness (facts change over time)
- Self-hostable, runs locally on a 16GB MacBook Pro
- MCP integration (OpenCode is the MCP client)
- Connectors for email (Gmail + Office 365) and ChatGPT history import
- Open source, no vendor lock-in

## Candidates Evaluated

### 1. mem0 (github.com/mem0ai/mem0)

- **Stars:** 50k | **License:** Apache 2.0 | **Language:** Python
- **What it does:** LLM extracts facts from conversations, decides ADD/UPDATE/DELETE against existing memories. Vector similarity search via Qdrant.
- **Graph support:** Optional, via Neo4j/Memgraph/Kuzu/Apache AGE. Kuzu was the embedded option but has been archived (Oct 2025).
- **Infrastructure:** Qdrant (vector DB) + Ollama (embeddings) + optional graph DB. ~2.5-4GB RAM.
- **MCP:** Community project (elvismdev/mem0-mcp-selfhosted) — well-built, 11 tools, session hooks, supports Claude OAT auth.
- **Connectors:** None built-in. BYO via separate MCP servers.
- **Strengths:** Most mature/popular, fully self-hostable, good community MCP integration.
- **Weaknesses:** Requires separate vector DB + embedding model. Graph is bolted on, not core. No native temporal awareness. Heavier infrastructure.
- **Hosted pricing:** Free tier (10k memories), $19/mo starter, $249/mo for graph memory.

### 2. supermemory (github.com/supermemoryai/supermemory)

- **Stars:** 17k | **License:** MIT | **Language:** TypeScript
- **What it does:** Memory engine with connectors (Gmail, Google Drive, Notion, OneDrive, GitHub). Claims "SQL-based" approach.
- **Reality:** Uses Postgres + pgvector + HNSW vector indexes + Cloudflare AI embeddings. Three levels of vector embeddings (documents, chunks, memories). The "SQL not vectors" claim is marketing — it's standard vector search stored in Postgres.
- **Infrastructure:** Cloudflare Workers + KV + Hyperdrive. Not truly self-hostable without Cloudflare.
- **SOTA claims:** Claims #1 on LongMemEval-S (81.6%). Does not compare against mem0. Already surpassed by Mastra (84.2%, self-reported). All benchmarks in this space are self-reported and cherry-picked.
- **Strengths:** Built-in connectors, memory graph layer, user profiling.
- **Weaknesses:** Cloudflare-native (vendor lock-in), misleading marketing about architecture, not practically self-hostable.

### 3. Memori (github.com/MemoriLabs/Memori)

- **Stars:** 12k | **License:** Apache 2.0 | **Language:** Python | **Contributors:** 34
- **What it does:** Claims "SQL instead of vectors" — stores embeddings as BLOBs in SQL tables, does cosine similarity in-process.
- **Reality:** Still uses embeddings (sentence-transformers). The approach is storing vectors in SQL instead of a dedicated vector DB. Reddit community was skeptical (top comment with 94 upvotes: "This is just RAG").
- **Infrastructure:** BYODB (SQLite/Postgres). Low overhead.
- **Concerns:** "Advanced Augmentation" extraction calls api.memorilabs.ai even in self-hosted mode (cloud dependency). Marketing overstates the novelty of the approach. In-process cosine similarity over all embeddings won't scale to large memory stores.
- **Not selected:** Cloud dependency in extraction pipeline, less architectural fit for graph-based use case.

### 4. Graphiti (github.com/getzep/graphiti) — SELECTED

- **Stars:** 24k | **License:** Apache 2.0 | **Language:** Python
- **What it does:** Temporal knowledge graph engine. Builds entity nodes + typed fact edges with time validity windows. Automatic contradiction invalidation. Graph traversal + semantic + keyword (BM25) hybrid retrieval.
- **Infrastructure:** Single Docker container (FalkorDB + MCP server). ~600-800MB RAM. No separate vector DB or embedding model needed — vectors stored inside graph DB.
- **Graph backends:** FalkorDB (default, Redis-based), Neo4j, Kuzu (embedded, archived).
- **MCP:** Official server maintained by Zep. HTTP transport. Pre-built Docker image. 9 tools + 2 graph tools.
- **LLM support:** OpenAI, Anthropic, Gemini, Groq, Ollama.
- **Strengths:** Lightest infrastructure, temporal awareness is first-class, graph traversal queries, maps closely to our design doc's nodes+edges schema, official MCP server, published research paper (arXiv:2501.13956).
- **Weaknesses:** More LLM calls per write (entity extraction + dedup + summarization + edge resolution). Higher token cost per ingestion.
- **Why selected:** Best fit for architecture (temporal graph, not flat facts), lightest infrastructure (single container, ~800MB, runs on 16GB MacBook), closest match to design doc's nodes+edges vision.

### 5. turbopuffer (turbopuffer.com)

- **What it is:** Serverless vector database on object storage. Pure search infrastructure — competes with Pinecone/Qdrant, not memory systems.
- **Customers:** Anthropic, Notion, Cursor, Linear. Serious infrastructure.
- **Not selected:** Wrong category. Infrastructure plumbing, not an application-level memory layer. Hosted only, not open source, starts at $64/mo.

### 6. Build our own (from design doc schema)

- **What it would be:** nodes + edges tables in SQLite, custom embedding + search + fact extraction.
- **Not selected:** Months of engineering to rebuild what Graphiti/mem0 already provide. Knowledge graph infrastructure is not Oyster's differentiator — the surface and workspace experience is.

## Benchmark Landscape (caveat emptor)

All "SOTA" claims in this space are self-reported and cherry-picked:

| Vendor | Benchmark | Score | Compares against |
|--------|-----------|-------|-----------------|
| supermemory | LongMemEval-S | 81.6% | Zep only (not mem0) |
| mem0 | LOCOMO | +26% vs OpenAI Memory | OpenAI only (not supermemory) |
| Mastra | LongMemEval-S | 84.2% | supermemory |
| Zep/Graphiti | LOCOMO | ~85% | Independent comparison (biased source) |

No neutral, standardized comparison exists. Each vendor picks the benchmark and model that flatters them most. supermemory created their own benchmarking framework ("MemoryBench") — grading their own homework. Pick based on architecture fit, not benchmark claims.

## Decision

**Graphiti** — temporal knowledge graph with FalkorDB, running locally via Docker.

- Spaces map to Graphiti `group_id`s for scoped context
- OpenCode connects via MCP (HTTP transport at localhost:8000/mcp/)
- Conversations saved as episodes, entities extracted automatically
- Email connectors (future) feed episodes into the graph
- ChatGPT history imported as episodes

See [GitHub issue #30](https://github.com/mattslight/oyster-os/issues/30) for implementation plan.
See [architecture diagram](../architecture-mem0.html) for visual overview.
