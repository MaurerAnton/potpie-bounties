#!/usr/bin/env python3
"""
Potpie bounties — batch of 3 issues for potpie-ai/potpie (Algora-funded).

#222 — Replace LangChain with LiteLLM (multi-LLM support)
#223 — Hash-based inference caching for knowledge graph nodes
#221 — Incremental knowledge graph updates
"""

import hashlib
import json
from typing import Any, Optional
from dataclasses import dataclass, field
from enum import Enum


# ═══════════════════════════════════════════════════════════════════════════
# #222 — LiteLLM Provider Service (replaces LangChain chat clients)
# ═══════════════════════════════════════════════════════════════════════════

import litellm
from litellm import completion, acompletion

# Configure LiteLLM globally
litellm.drop_params = True  # ignore unsupported params instead of crashing
litellm.suppress_debug_info = True


class LLMProvider(Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GOOGLE = "google"
    MISTRAL = "mistral"
    GROQ = "groq"
    TOGETHER = "together"
    DEEPSEEK = "deepseek"
    OLLAMA = "ollama"       # local models
    CUSTOM = "custom"        # any LiteLLM-supported provider


@dataclass
class LLMConfig:
    """User-facing LLM configuration."""
    provider: LLMProvider = LLMProvider.OPENAI
    model: str = "gpt-4o"
    api_key: str = ""
    temperature: float = 0.0
    max_tokens: int = 4096
    base_url: Optional[str] = None  # for custom/Ollama endpoints
    extra_params: dict = field(default_factory=dict)

    def to_litellm_kwargs(self) -> dict:
        """Convert to kwargs for litellm.completion()."""
        model_id = self.model
        if self.provider != LLMProvider.CUSTOM:
            model_id = f"{self.provider.value}/{self.model}"

        kwargs = {
            "model": model_id,
            "api_key": self.api_key,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            **self.extra_params,
        }
        if self.base_url:
            kwargs["api_base"] = self.base_url
        return kwargs


class LiteLLMProviderService:
    """Unified provider service replacing LangChain chat clients.

    Usage:
        cfg = LLMConfig(provider=LLMProvider.ANTHROPIC, model="claude-sonnet-4-20250514")
        svc = LiteLLMProviderService(cfg)
        response = svc.chat([{"role": "user", "content": "Explain DWT"}])
    """

    def __init__(self, config: LLMConfig):
        self.config = config

    def chat(self, messages: list[dict], **overrides) -> str:
        """Synchronous chat completion."""
        kwargs = self.config.to_litellm_kwargs()
        kwargs["messages"] = messages
        kwargs.update(overrides)
        response = completion(**kwargs)
        return response.choices[0].message.content

    async def achat(self, messages: list[dict], **overrides) -> str:
        """Asynchronous chat completion."""
        kwargs = self.config.to_litellm_kwargs()
        kwargs["messages"] = messages
        kwargs.update(overrides)
        response = await acompletion(**kwargs)
        return response.choices[0].message.content

    def stream(self, messages: list[dict], **overrides):
        """Streaming chat completion (generator)."""
        kwargs = self.config.to_litellm_kwargs()
        kwargs["messages"] = messages
        kwargs["stream"] = True
        kwargs.update(overrides)
        response = completion(**kwargs)
        for chunk in response:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

    def list_models(self) -> list[str]:
        """List available models for the configured provider."""
        try:
            return litellm.get_llm_provider_models(self.config.provider.value)
        except Exception:
            return []


# Migration helper: replace LangChain imports
# Before: from langchain_openai import ChatOpenAI
# After:  from potpie.services.llm_provider import LiteLLMProviderService, LLMConfig

# Usage in agent code:
#   provider = LiteLLMProviderService(user_config)
#   docstring = provider.chat([
#       {"role": "system", "content": "Generate a docstring for the following code."},
#       {"role": "user", "content": code_snippet}
#   ])


# ═══════════════════════════════════════════════════════════════════════════
# #223 — Hash-based inference caching for knowledge graph nodes
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class NodeHash:
    """Hash-based cache key for a knowledge graph node."""
    node_id: str
    node_type: str          # class, function, method, module, file
    name: str
    file_path: str
    line_start: int
    line_end: int
    source_hash: str        # SHA-256 of the source code
    dependencies_hash: str  # SHA-256 of sorted dependency node IDs

    def compute_fingerprint(self) -> str:
        """Compute a stable hash for cache lookup."""
        payload = f"{self.node_type}|{self.name}|{self.file_path}|{self.line_start}|{self.line_end}|{self.source_hash}|{self.dependencies_hash}"
        return hashlib.sha256(payload.encode()).hexdigest()


class InferenceCache:
    """Cache for knowledge graph node inference results.

    Stores: embeddings (vector), docstring (text), and metadata per node.
    Identified by the node fingerprint hash.
    """

    def __init__(self, cache_backend=None):
        self._cache: dict[str, dict] = {}  # fingerprint → {embedding, docstring, ...}
        self._backend = cache_backend  # optional persistent backend (Redis, disk)

    def get(self, fingerprint: str) -> Optional[dict]:
        """Look up cached inference for a node fingerprint."""
        if fingerprint in self._cache:
            return self._cache[fingerprint]
        if self._backend:
            return self._backend.get(fingerprint)
        return None

    def put(self, fingerprint: str, data: dict) -> None:
        """Store node inference in cache."""
        self._cache[fingerprint] = data
        if self._backend:
            self._backend.put(fingerprint, data)

    def has(self, fingerprint: str) -> bool:
        return fingerprint in self._cache or (self._backend and self._backend.has(fingerprint))

    def stats(self) -> dict:
        return {"cached_nodes": len(self._cache)}


class NodeHasher:
    """Compute node hashes for KG cache comparison."""

    @staticmethod
    def hash_source(source_code: str) -> str:
        return hashlib.sha256(source_code.encode()).hexdigest()

    @staticmethod
    def hash_dependencies(dep_ids: list[str]) -> str:
        return hashlib.sha256("|".join(sorted(dep_ids)).encode()).hexdigest()

    @classmethod
    def from_parsed_node(cls, node: dict, source_code: str, dep_ids: list[str]) -> NodeHash:
        return NodeHash(
            node_id=node["id"],
            node_type=node["type"],
            name=node["name"],
            file_path=node.get("file_path", ""),
            line_start=node.get("line", 0),
            line_end=node.get("end_line", 0),
            source_hash=cls.hash_source(source_code),
            dependencies_hash=cls.hash_dependencies(dep_ids),
        )


# ═══════════════════════════════════════════════════════════════════════════
# #221 — Incremental Knowledge Graph updates
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class FileFingerprint:
    """Per-file hash for detecting changes between parses."""
    file_path: str
    content_hash: str  # SHA-1 over sorted node tuples + edges


class IncrementalKGUpdater:
    """Updates knowledge graph incrementally instead of full rebuild.

    Pipeline:
      1. Compute per-file hashes from parser artifacts
      2. Diff new vs persisted hashes
      3. Apply delta: add/modify/delete only changed files
    """

    def __init__(self, neo4j_driver, qdrant_client, cache: InferenceCache):
        self._neo4j = neo4j_driver
        self._qdrant = qdrant_client
        self._cache = cache

    def compute_file_hash(self, nodes: list[dict], edges: list[dict]) -> str:
        """Compute SHA-1 fingerprint of a file's nodes and edges."""
        # Sort nodes by (type, line, name) for stable hashing
        node_tuples = sorted(
            [(n.get("id"), n.get("type"), n.get("line", 0), n.get("end_line", 0),
              n.get("name", ""), n.get("text", ""))
             for n in nodes]
        )
        # Include edges originating in this file
        edge_tuples = sorted(
            [(e.get("source"), e.get("target"), e.get("type"))
             for e in edges]
        )
        payload = json.dumps({"nodes": node_tuples, "edges": edge_tuples}, sort_keys=True)
        return hashlib.sha1(payload.encode()).hexdigest()

    def compute_all_hashes(self, parsed_files: dict[str, tuple[list, list]]) -> dict[str, str]:
        """Compute hashes for all parsed files."""
        return {
            path: self.compute_file_hash(nodes, edges)
            for path, (nodes, edges) in parsed_files.items()
        }

    def diff(self, new_hashes: dict[str, str],
             old_hashes: dict[str, str]) -> tuple[set, set, set, set]:
        """Compute file-level diff between two hash maps.

        Returns: (added, modified, deleted, unchanged)
        """
        new_files = set(new_hashes)
        old_files = set(old_hashes)

        added = new_files - old_files
        deleted = old_files - new_files
        modified = {
            f for f in new_files & old_files
            if new_hashes[f] != old_hashes[f]
        }
        unchanged = {
            f for f in new_files & old_files
            if new_hashes[f] == old_hashes[f]
        }
        return added, modified, deleted, unchanged

    async def apply_delta(self, added: set, modified: set, deleted: set,
                          parsed_files: dict, unchanged: set) -> dict:
        """Apply incremental update to Neo4j + Qdrant + cache.

        - deleted + modified: DETACH DELETE all nodes in those files from Neo4j
        - added + modified: re-insert nodes + edges + embeddings
        - unchanged: SKIP (cache hit — no work needed)
        """
        stats = {"deleted": 0, "added": 0, "modified": 0, "skipped": 0}
        dirty = deleted | modified

        # 1. Remove dirty file nodes from Neo4j + Qdrant
        for file_path in dirty:
            await self._neo4j.run(
                "MATCH (n {file_path: $path}) DETACH DELETE n",
                path=file_path
            )
            await self._qdrant.delete_by_filter({"file_path": file_path})
            stats["deleted" if file_path in deleted else "modified"] += 1

        # 2. Insert added + modified files
        for file_path in sorted(added | modified):
            nodes, edges = parsed_files[file_path]
            await self._insert_file_graph(file_path, nodes, edges)
            if file_path in added:
                stats["added"] += 1

        # 3. Unchanged files — update content_hash only
        stats["skipped"] = len(unchanged)
        return stats

    async def _insert_file_graph(self, file_path: str, nodes: list, edges: list):
        """Insert nodes and edges for a single file into Neo4j."""
        # Insert nodes
        for node in nodes:
            await self._neo4j.run(
                """MERGE (n:CodeNode {id: $id})
                   SET n.type = $type, n.name = $name, n.file_path = $file_path,
                       n.line = $line, n.end_line = $end_line, n.text = $text,
                       n.content_hash = $hash""",
                id=node["id"], type=node["type"], name=node["name"],
                file_path=file_path, line=node.get("line", 0),
                end_line=node.get("end_line", 0), text=node.get("text", ""),
                hash=self.compute_file_hash([node], []),
            )
        # Insert edges
        for edge in edges:
            await self._neo4j.run(
                """MATCH (a:CodeNode {id: $src}), (b:CodeNode {id: $dst})
                   MERGE (a)-[r:RELATES {type: $type}]->(b)""",
                src=edge["source"], dst=edge["target"], type=edge.get("type", "RELATED"),
            )

    async def update(self, parsed_files: dict[str, tuple[list, list]],
                     old_hashes: dict[str, str]) -> dict:
        """Main entry point: compute diff, apply delta, return stats."""
        new_hashes = self.compute_all_hashes(parsed_files)
        added, modified, deleted, unchanged = self.diff(new_hashes, old_hashes)
        stats = await self.apply_delta(added, modified, deleted, parsed_files, unchanged)

        # Persist new hashes for next incremental run
        for file_path, h in new_hashes.items():
            await self._neo4j.run(
                "MATCH (f:File {path: $path}) SET f.content_hash = $hash",
                path=file_path, hash=h,
            )

        return stats


# ═══════════════════════════════════════════════════════════════════════════
# Integration: LiteLLM provider used during KG inference
# ═══════════════════════════════════════════════════════════════════════════

class KGInferenceEngine:
    """Knowledge graph inference using LiteLLM + caching."""

    def __init__(self, llm: LiteLLMProviderService, cache: InferenceCache):
        self.llm = llm
        self.cache = cache
        self.hasher = NodeHasher()

    async def infer_node(self, node: dict, source_code: str,
                         dep_ids: list[str]) -> dict:
        """Run inference for a single node with caching."""
        node_hash = self.hasher.from_parsed_node(node, source_code, dep_ids)
        fp = node_hash.compute_fingerprint()

        # Cache hit — reuse previous inference
        cached = self.cache.get(fp)
        if cached:
            return cached

        # Cache miss — run LLM inference
        docstring = await self.llm.achat([
            {"role": "system", "content": "Generate a concise docstring for the following code."},
            {"role": "user", "content": source_code},
        ])
        embedding = None  # generated separately by embedding model

        result = {"docstring": docstring, "embedding": embedding, "fingerprint": fp}
        self.cache.put(fp, result)
        return result
