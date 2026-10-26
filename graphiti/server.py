"""Graphiti stdio JSON-RPC server.

Communicates with the Node.js bot over stdin/stdout using JSON-RPC 2.0.
Each request is a single JSON line on stdin; each response is a single JSON line on stdout.

Methods:
    initialize      — connect to Neo4j, build indices
    add_episodes    — batch-add chat messages as episodes
    search          — semantic search for memories
    get_edges       — list edges for a group (with pagination)
    get_edge        — get a single edge by uuid
    delete_edge     — delete a single edge by uuid
    delete_group    — delete all data for a group
    get_nodes       — list nodes of a given label for a group (with pagination)
    get_subgraph    — entity fact subgraph for a group (nodes + RELATES_TO edges)
    get_neighbors   — 1-hop fact subgraph around a single entity node
    shutdown        — graceful shutdown
"""

from __future__ import annotations

import asyncio
import json
import signal
import sys
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
import pythonmonkey
from neo4j.time import DateTime as Neo4jDateTime

from graphiti_core import Graphiti
from graphiti_core.nodes import EpisodeType
from graphiti_core.llm_client import client as llm_client
import graphiti_core.llm_client.openai_generic_client as _ogc
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from openai import AsyncOpenAI, omit
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient


# ---------------------------------------------------------------------------
# Extraction language override
# ---------------------------------------------------------------------------
# graphiti-core 默认在每次 LLM 调用的 system message 末尾追加
# get_extraction_language_instruction() 的返回值，默认文案以 "Otherwise, output English."
# 结尾，导致纯中文群聊被抽成「英文骨架 + 中文引语」的记忆。
# 该函数的 docstring 明确声明 "Override this function to customize language extraction"，
# 这里按官方扩展点覆写为简体中文指令；generate_response 是所有生成型调用（抽取/摘要/去重）
# 的唯一出口，覆写一处即全覆盖。注意 openai_generic_client 以 from-import 按名绑定，
# 需一并替换。库升级若改动该函数名/调用点，覆写会静默失效，initialize 日志可确认生效。
CHINESE_LANGUAGE_INSTRUCTION = (
    '\n\n输入的对话为简体中文。所有生成内容——事实（fact）、实体摘要、实体名称、属性值——必须以简体中文书写。'
    '专有名词保持原样：用户昵称、群名称、产品/型号名称、技术术语、引用的聊天原话，一律不翻译。'
    '日期与时间一律写成 yyyy-MM-dd HH:mm 格式。'
)


def _chinese_language_instruction(group_id: str | None = None) -> str:
    return CHINESE_LANGUAGE_INSTRUCTION


def apply_language_override() -> None:
    """覆写 graphiti-core 的语言指令扩展点（含 openai_generic_client 的按名绑定）。"""
    llm_client.get_extraction_language_instruction = _chinese_language_instruction
    _ogc.get_extraction_language_instruction = _chinese_language_instruction


# ---------------------------------------------------------------------------
# Thinking 开关
# ---------------------------------------------------------------------------
# 部分 OpenAI 兼容端点默认开启深度思考：思考链与回答共享 max_tokens 额度，
# 思考过长会截断 JSON 输出（触发重试），且每轮调用延迟显著增加。
# 这类端点通常支持通过 extra_body 传入 {"thinking": {"type": "disabled"}} 关闭。
# graphiti-core 的 OpenAIGenericClient 不支持 extra_body，这里在 AsyncOpenAI
# 资源实例上打补丁（chat/completions 为 cached_property，实例属性赋值生效）。


def _wrap_disable_thinking(client: AsyncOpenAI) -> None:
    """给 AsyncOpenAI 客户端的 chat.completions.create 注入 thinking=disabled。"""
    original_create = client.chat.completions.create

    async def create_with_thinking_disabled(*args: Any, **kwargs: Any) -> Any:
        extra_body = dict(kwargs.get('extra_body') or {})
        extra_body.setdefault('thinking', {'type': 'disabled'})
        kwargs['extra_body'] = extra_body
        return await original_create(*args, **kwargs)

    client.chat.completions.create = create_with_thinking_disabled  # type: ignore[method-assign]


# ---------------------------------------------------------------------------
# 不发送 response_format
# ---------------------------------------------------------------------------
# 部分端点的模型不支持结构化输出（json_schema 被严格校验拒绝，json_object 也不接受），
# 此时只能把 schema 写进 prompt，由模型自行生成 JSON，再交给 pydantic 校验。
# graphiti-core 的 json_object 模式正是把 schema 拼入 prompt 的那个路径，因此构造时仍传
# json_object，再在传输层移除请求体中的 response_format 字段。


def _wrap_strip_response_format(client: AsyncOpenAI) -> None:
    """移除请求中的 response_format 字段。"""
    original_create = client.chat.completions.create

    async def create_without_response_format(*args: Any, **kwargs: Any) -> Any:
        kwargs.pop('response_format', None)
        return await original_create(*args, **kwargs)

    client.chat.completions.create = create_without_response_format  # type: ignore[method-assign]


# ---------------------------------------------------------------------------
# JSON 输出清洗
# ---------------------------------------------------------------------------
# 部分 OpenAI 兼容端点不强制执行 response_format：模型返回的 JSON 可能被 markdown
# 围栏包裹、被 max_tokens 截断，或在完整 JSON 之后继续输出多余内容，graphiti-core
# 的裸 json.loads 遇到这些情况即抛 JSONDecodeError（Extra data），tenacity 重试
# 4 次后整个 episode 添加失败。这里在传输层用 jsonrepair（graphiti/json_repair.js）
# 修复 content：覆盖围栏、截断、缺失括号等，根值之后的额外内容按 jsonrepair 给出的
# 出错位置截断后重试。修复结果与原内容相同时视为无需清洗；无法修复时保持原样，
# 交给库自身的重试与报错路径。

_json_repair = pythonmonkey.require('./json_repair')


def _repair_json_content(content: str) -> str | None:
    """用 jsonrepair 修复模型返回的 JSON 文本；无需修复或无法修复时返回 None。"""
    try:
        repaired = _json_repair.repairJsonText(content)
    except pythonmonkey.SpiderMonkeyError:
        return None
    if repaired == content:
        return None
    return repaired


def _wrap_json_sanitize(client: AsyncOpenAI) -> None:
    """给 AsyncOpenAI 客户端的 chat.completions.create 注入 JSON 输出清洗。"""
    original_create = client.chat.completions.create

    async def create_json_sanitized(*args: Any, **kwargs: Any) -> Any:
        response = await original_create(*args, **kwargs)
        msg = response.choices[0].message
        content = msg.content
        if not content:
            return response
        repaired = _repair_json_content(content)
        if repaired is not None:
            print(
                f'[Graphiti] sanitized LLM response: repaired invalid JSON '
                f'({len(content)} -> {len(repaired)} chars)',
                file=sys.stderr,
            )
            print(f'[Graphiti] raw LLM response: {content!r}', file=sys.stderr)
            print(f'[Graphiti] repaired LLM response: {repaired!r}', file=sys.stderr)
            msg.content = repaired
        return response

    client.chat.completions.create = create_json_sanitized  # type: ignore[method-assign]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_line() -> str | None:
    """Read a single line from stdin. Returns None on EOF."""
    line = sys.stdin.readline()
    if not line:
        return None
    return line.rstrip("\n")


class _JsonEncoder(json.JSONEncoder):
    """Handle Neo4j temporal types and other non-standard objects."""
    def default(self, o: Any) -> Any:
        if isinstance(o, Neo4jDateTime):
            return o.isoformat()
        if hasattr(o, 'isoformat'):
            return o.isoformat()
        if hasattr(o, '__str__'):
            return str(o)
        return super().default(o)


def _write_response(response: dict[str, Any]) -> None:
    """Write a JSON-RPC response to stdout."""
    sys.stdout.write(json.dumps(response, ensure_ascii=False, cls=_JsonEncoder) + "\n")
    sys.stdout.flush()


def _ok(id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id, "result": result}


def _err(id: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    resp: dict[str, Any] = {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}
    if data is not None:
        resp["error"]["data"] = data
    return resp


def _serialize_edge(edge: Any) -> dict[str, Any]:
    """Serialize an EntityEdge to a JSON-friendly dict."""
    return {
        "uuid": str(edge.uuid) if edge.uuid else None,
        "name": edge.name,
        "fact": edge.fact,
        "source_node_uuid": str(edge.source_node_uuid) if edge.source_node_uuid else None,
        "target_node_uuid": str(edge.target_node_uuid) if edge.target_node_uuid else None,
        "group_id": edge.group_id,
        "created_at": edge.created_at.isoformat() if edge.created_at else None,
        "valid_at": edge.valid_at.isoformat() if edge.valid_at else None,
        "invalid_at": edge.invalid_at.isoformat() if edge.invalid_at else None,
        "expired_at": edge.expired_at.isoformat() if edge.expired_at else None,
        "attributes": edge.attributes if edge.attributes else {},
    }


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Serialize a raw Cypher row into a JSON-friendly dict (Neo4j temporal types)."""
    out: dict[str, Any] = {}
    for key, value in row.items():
        if hasattr(value, 'isoformat'):
            out[key] = value.isoformat()
        else:
            out[key] = value
    return out


# ---------------------------------------------------------------------------
# Server state
# ---------------------------------------------------------------------------

@dataclass
class ServerState:
    graphiti: Graphiti | None = None
    initialized: bool = False
    config: dict[str, Any] = field(default_factory=dict)
    # 添加记忆之间互斥：graphiti-core 的写入路径不保证并发安全，
    # add_episode 之间串行执行；只读方法（search/get_*）不加锁，与添加并发执行
    add_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


state = ServerState()


# ---------------------------------------------------------------------------
# Method handlers
# ---------------------------------------------------------------------------

async def handle_initialize(params: dict[str, Any]) -> Any:
    """Initialize Graphiti connection and build indices."""
    neo4j_uri = params.get("neo4j_uri", "bolt://localhost:7687")
    neo4j_user = params.get("neo4j_user", "neo4j")
    neo4j_password = params.get("neo4j_password", "password")

    # LLM config
    llm_cfg = params.get("llm", {})
    llm_max_tokens: int = llm_cfg.get("max_tokens", 16384)
    llm_config = LLMConfig(
        api_key=llm_cfg.get("api_key", ""),
        model=llm_cfg.get("model", "gpt-4o-mini"),
        small_model=llm_cfg.get("small_model", llm_cfg.get("model", "gpt-4o-mini")),
        base_url=llm_cfg.get("base_url"),
        temperature=llm_cfg.get("temperature", 0),
        max_tokens=llm_max_tokens,
    )
    # ai.graphiti.llm.headers：值为 null 表示删除 SDK 默认头部。Python SDK 删除默认头部
    # 需要在 client 的 default_headers 中传 omit 哨兵（_build_headers 经 _merge_mappings
    # 剔除 Omit 项），直接传 None 会作为头部值进入 httpx 而报错。
    llm_headers = llm_cfg.get("headers") or {}
    default_headers = {
        name: (omit if value is None else value)
        for name, value in llm_headers.items()
    }
    openai_client = AsyncOpenAI(
        api_key=llm_config.api_key,
        base_url=llm_config.base_url,
        default_headers=default_headers or None,
    )
    if llm_cfg.get("disable_thinking", False):
        _wrap_disable_thinking(openai_client)
    structured_output_mode = llm_cfg.get("structured_output_mode", "json_schema")
    if structured_output_mode == "none":
        # 端点不接受任何 response_format：schema 走 prompt，请求体中移除该字段
        _wrap_strip_response_format(openai_client)
        structured_output_mode = "json_object"
    _wrap_json_sanitize(openai_client)
    # 注意：OpenAIGenericClient 构造函数的 max_tokens 参数会覆盖 LLMConfig 中的
    # 同名配置，必须显式透传，否则静默回落到库默认的 16384
    llm_client = OpenAIGenericClient(
        config=llm_config,
        client=openai_client,
        max_tokens=llm_max_tokens,
        structured_output_mode=structured_output_mode,
    )

    # Embedder config
    emb_cfg = params.get("embedder", {})
    embedder = OpenAIEmbedder(
        config=OpenAIEmbedderConfig(
            api_key=emb_cfg.get("api_key", ""),
            embedding_model=emb_cfg.get("model", "text-embedding-3-small"),
            embedding_dim=emb_cfg.get("dimension", 1536),
            base_url=emb_cfg.get("base_url"),
        )
    )

    # Reranker (cross-encoder) config
    reranker_cfg = params.get("reranker", {})
    cross_encoder = None
    if reranker_cfg:
        reranker_llm_config = LLMConfig(
            api_key=reranker_cfg.get("api_key", ""),
            base_url=reranker_cfg.get("base_url"),
            model=reranker_cfg.get("model"),
        )
        cross_encoder = OpenAIRerankerClient(config=reranker_llm_config)

    graphiti_kwargs: dict[str, Any] = {
        "uri": neo4j_uri,
        "user": neo4j_user,
        "password": neo4j_password,
        "llm_client": llm_client,
        "embedder": embedder,
    }
    if cross_encoder is not None:
        graphiti_kwargs["cross_encoder"] = cross_encoder

    state.graphiti = Graphiti(**graphiti_kwargs)
    await state.graphiti.build_indices_and_constraints()
    state.initialized = True
    state.config = params

    # 覆写语言指令扩展点；若库升级改名会导致覆写静默失效，这里做基本校验并提示
    apply_language_override()
    if getattr(_ogc, 'get_extraction_language_instruction', None) is not _chinese_language_instruction:
        print('[Graphiti] warning: language override did not take effect', file=sys.stderr)

    return {"status": "ok"}


async def handle_add_episode(params: dict[str, Any]) -> Any:
    """Add a single episode to Graphiti."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    group_id: str = params["group_id"]
    name: str = params["name"]
    content: str = params["content"]
    source_description: str = params.get("source_description", "")
    reference_time_raw = params.get("reference_time")

    if isinstance(reference_time_raw, str):
        ref_dt = datetime.fromisoformat(reference_time_raw)
    elif isinstance(reference_time_raw, (int, float)):
        ref_dt = datetime.fromtimestamp(reference_time_raw, tz=timezone.utc)
    else:
        ref_dt = datetime.now(timezone.utc)

    async with state.add_lock:
        result = await state.graphiti.add_episode(
            name=name,
            episode_body=content,
            source_description=source_description,
            reference_time=ref_dt,
            source=EpisodeType.json,
            group_id=group_id,
        )

    return {"status": "ok", "episode_uuid": getattr(result, "episode_uuid", None)}


async def handle_search(params: dict[str, Any]) -> Any:
    """Search for memories."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    query: str = params["query"]
    group_id: str = params["group_id"]
    num_results: int = params.get("num_results", 10)

    edges = await state.graphiti.search(
        query=query,
        group_ids=[group_id],
        num_results=num_results,
    )

    return {
        "results": [_serialize_edge(e) for e in edges],
        "count": len(edges),
    }


async def handle_get_edges(params: dict[str, Any]) -> Any:
    """List edges for a group (paginated)."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    group_id: str = params["group_id"]
    limit: int = params.get("limit", 50)
    offset: int = params.get("offset", 0)

    driver = state.graphiti.driver

    query = """
        MATCH (n)-[r]->(m)
        WHERE r.group_id = $group_id
        RETURN r, n.uuid AS source_uuid, m.uuid AS target_uuid
        ORDER BY r.created_at DESC
        SKIP $offset
        LIMIT $limit
    """
    records, _, _ = await driver.execute_query(
        query,
        group_id=group_id,
        offset=offset,
        limit=limit,
    )

    edges = []
    for record in records:
        r = record["r"]
        fact = r.get("fact")
        if not fact:
            continue
        edges.append({
            "uuid": r.get("uuid"),
            "name": r.get("name"),
            "fact": fact,
            "group_id": r.get("group_id"),
            "created_at": r.get("created_at"),
            "valid_at": r.get("valid_at"),
            "invalid_at": r.get("invalid_at"),
            "expired_at": r.get("expired_at"),
            "source_node_uuid": record["source_uuid"],
            "target_node_uuid": record["target_uuid"],
        })

    # Get total count (only edges with fact content)
    count_query = """
        MATCH (n)-[r]->(m)
        WHERE r.group_id = $group_id AND r.fact IS NOT NULL AND r.fact <> ''
        RETURN count(r) AS total
    """
    count_records, _, _ = await driver.execute_query(count_query, group_id=group_id)
    total = count_records[0]["total"] if count_records else 0

    return {"edges": edges, "total": total, "offset": offset, "limit": limit}


async def handle_get_edge(params: dict[str, Any]) -> Any:
    """Get a single edge by uuid."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    edge_uuid: str = params["uuid"]

    driver = state.graphiti.driver
    query = """
        MATCH (n)-[r]->(m)
        WHERE r.uuid = $uuid
        RETURN r, n.uuid AS source_uuid, m.uuid AS target_uuid
    """
    records, _, _ = await driver.execute_query(query, uuid=edge_uuid)

    if not records:
        return None

    r = records[0]["r"]
    return {
        "uuid": r.get("uuid"),
        "name": r.get("name"),
        "fact": r.get("fact"),
        "group_id": r.get("group_id"),
        "created_at": r.get("created_at"),
        "valid_at": r.get("valid_at"),
        "invalid_at": r.get("invalid_at"),
        "expired_at": r.get("expired_at"),
        "source_node_uuid": records[0]["source_uuid"],
        "target_node_uuid": records[0]["target_uuid"],
    }


async def handle_delete_edge(params: dict[str, Any]) -> Any:
    """Delete a single edge by uuid."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    edge_uuid: str = params["uuid"]
    driver = state.graphiti.driver

    query = """
        MATCH ()-[r]->()
        WHERE r.uuid = $uuid
        DELETE r
    """
    await driver.execute_query(query, uuid=edge_uuid)
    return {"deleted": True}


async def handle_delete_group(params: dict[str, Any]) -> Any:
    """Delete all data for a group."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    group_id: str = params["group_id"]
    driver = state.graphiti.driver

    for label in ("Entity", "Episodic", "Community"):
        query = f"""
            MATCH (n:{label})
            WHERE n.group_id = $group_id
            DETACH DELETE n
        """
        await driver.execute_query(query, group_id=group_id)

    return {"deleted": True}


def _serialize_node_row(row: Any) -> dict[str, Any]:
    """Serialize a node Cypher row (uuid/name/summary/group_id/created_at)."""
    data = _serialize_row(row)
    return {
        "uuid": data.get("uuid"),
        "name": data.get("name"),
        "summary": data.get("summary"),
        "group_id": data.get("group_id"),
        "created_at": data.get("created_at"),
    }


# 图节点标签白名单（Cypher 的 label 不能参数化，必须白名单拼接）
NODE_LABELS = ("Entity", "Episodic", "Community")


async def handle_get_nodes(params: dict[str, Any]) -> Any:
    """List nodes of a given label for a group (paginated)."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    group_id: str = params["group_id"]
    label: str = params.get("label", "Entity")
    if label not in NODE_LABELS:
        raise ValueError(f"Invalid label: {label}. Must be one of {NODE_LABELS}")
    limit: int = min(int(params.get("limit", 50)), 500)
    offset: int = max(int(params.get("offset", 0)), 0)

    driver = state.graphiti.driver

    query = f"""
        MATCH (n:{label})
        WHERE n.group_id = $group_id
        RETURN n.uuid AS uuid, n.name AS name, n.summary AS summary,
               n.group_id AS group_id, n.created_at AS created_at
        ORDER BY n.created_at DESC
        SKIP $offset
        LIMIT $limit
    """
    records, _, _ = await driver.execute_query(
        query,
        group_id=group_id,
        offset=offset,
        limit=limit,
    )
    nodes = [_serialize_node_row(record) for record in records]

    count_query = f"""
        MATCH (n:{label})
        WHERE n.group_id = $group_id
        RETURN count(n) AS total
    """
    count_records, _, _ = await driver.execute_query(count_query, group_id=group_id)
    total = count_records[0]["total"] if count_records else 0

    return {"label": label, "nodes": nodes, "total": total, "offset": offset, "limit": limit}


async def handle_search_nodes(params: dict[str, Any]) -> Any:
    """Search for entity nodes by name using Graphiti's node_fulltext_search API."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    query: str = params["query"]
    group_id: str = params["group_id"]
    num_results: int = min(int(params.get("num_results", 10)), 50)

    # 使用 Graphiti 的 node_fulltext_search API
    from graphiti_core.search.search_utils import node_fulltext_search
    from graphiti_core.search.search_filters import SearchFilters

    search_filter = SearchFilters()
    nodes = await node_fulltext_search(
        driver=state.graphiti.driver,
        query=query,
        search_filter=search_filter,
        group_ids=[group_id],
        limit=num_results
    )

    # 序列化节点
    serialized_nodes = []
    for node in nodes:
        serialized_nodes.append({
            "uuid": str(node.uuid) if node.uuid else None,
            "name": node.name,
            "summary": node.summary,
            "group_id": node.group_id,
            "created_at": node.created_at.isoformat() if node.created_at else None,
        })

    return {"nodes": serialized_nodes, "count": len(serialized_nodes)}


async def handle_get_subgraph(params: dict[str, Any]) -> Any:
    """Entity fact subgraph for a group: Entity nodes + fact RELATES_TO edges.

    Returns the most recent `limit` edges and all Entity endpoints involved.
    """
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    group_id: str = params["group_id"]
    limit: int = min(int(params.get("limit", 200)), 1000)

    driver = state.graphiti.driver

    edge_query = """
        MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
        WHERE r.group_id = $group_id AND r.fact IS NOT NULL AND r.fact <> ''
        RETURN a.uuid AS source_uuid, a.name AS source_name,
               a.summary AS source_summary, a.group_id AS source_group_id,
               b.uuid AS target_uuid, b.name AS target_name,
               b.summary AS target_summary, b.group_id AS target_group_id,
               r.uuid AS uuid, r.fact AS fact, r.created_at AS created_at,
               r.valid_at AS valid_at, r.invalid_at AS invalid_at,
               r.expired_at AS expired_at
        ORDER BY r.created_at DESC
        LIMIT $limit
    """
    records, _, _ = await driver.execute_query(edge_query, group_id=group_id, limit=limit)

    nodes_by_uuid: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    for record in records:
        row = _serialize_row(record)
        for prefix in ("source", "target"):
            uuid = row[f"{prefix}_uuid"]
            if uuid and uuid not in nodes_by_uuid:
                nodes_by_uuid[uuid] = {
                    "uuid": uuid,
                    "name": row[f"{prefix}_name"],
                    "summary": row[f"{prefix}_summary"],
                    "group_id": row[f"{prefix}_group_id"],
                    "created_at": None,
                }
        edges.append({
            "uuid": row["uuid"],
            "fact": row["fact"],
            "created_at": row["created_at"],
            "valid_at": row["valid_at"],
            "invalid_at": row["invalid_at"],
            "expired_at": row["expired_at"],
            "source_node_uuid": row["source_uuid"],
            "target_node_uuid": row["target_uuid"],
        })

    count_query = """
        MATCH ()-[r:RELATES_TO]->()
        WHERE r.group_id = $group_id AND r.fact IS NOT NULL AND r.fact <> ''
        RETURN count(r) AS total
    """
    count_records, _, _ = await driver.execute_query(count_query, group_id=group_id)
    total_edges = count_records[0]["total"] if count_records else 0

    return {
        "nodes": list(nodes_by_uuid.values()),
        "edges": edges,
        "total_edges": total_edges,
        "limit": limit,
    }


async def handle_get_neighbors(params: dict[str, Any]) -> Any:
    """1-hop fact subgraph around an entity: center node + neighbor entities + fact edges."""
    if not state.initialized or state.graphiti is None:
        raise RuntimeError("Server not initialized")

    node_uuid: str = params["uuid"]
    limit: int = min(int(params.get("limit", 100)), 500)

    driver = state.graphiti.driver

    center_query = """
        MATCH (n:Entity {uuid: $uuid})
        RETURN n.uuid AS uuid, n.name AS name, n.summary AS summary,
               n.group_id AS group_id, n.created_at AS created_at
    """
    center_records, _, _ = await driver.execute_query(center_query, uuid=node_uuid)
    if not center_records:
        raise ValueError(f"Node not found: {node_uuid}")
    center = _serialize_node_row(center_records[0])

    edge_query = """
        MATCH (m:Entity)-[r:RELATES_TO]-(n:Entity {uuid: $uuid})
        WHERE r.fact IS NOT NULL AND r.fact <> ''
        RETURN m.uuid AS other_uuid, m.name AS other_name, m.summary AS other_summary,
               m.group_id AS other_group_id, m.created_at AS other_created_at,
               startNode(r).uuid AS source_uuid,
               endNode(r).uuid AS target_uuid,
               r.uuid AS uuid, r.fact AS fact, r.created_at AS created_at,
               r.valid_at AS valid_at, r.invalid_at AS invalid_at,
               r.expired_at AS expired_at
        ORDER BY r.created_at DESC
        LIMIT $limit
    """
    records, _, _ = await driver.execute_query(edge_query, uuid=node_uuid, limit=limit)

    nodes: list[dict[str, Any]] = [center]
    seen = {center["uuid"]}
    edges: list[dict[str, Any]] = []
    for record in records:
        row = _serialize_row(record)
        if row["other_uuid"] not in seen:
            nodes.append({
                "uuid": row["other_uuid"],
                "name": row["other_name"],
                "summary": row["other_summary"],
                "group_id": row["other_group_id"],
                "created_at": row["other_created_at"],
            })
            seen.add(row["other_uuid"])
        edges.append({
            "uuid": row["uuid"],
            "fact": row["fact"],
            "created_at": row["created_at"],
            "valid_at": row["valid_at"],
            "invalid_at": row["invalid_at"],
            "expired_at": row["expired_at"],
            "source_node_uuid": row["source_uuid"],
            "target_node_uuid": row["target_uuid"],
        })

    return {"node": center, "nodes": nodes, "edges": edges, "limit": limit}


async def handle_shutdown(_params: dict[str, Any]) -> Any:
    """响应关闭请求；实际关闭由 main 循环等待在途任务完成后执行。"""
    return {"status": "shutting_down"}


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

METHODS: dict[str, Any] = {
    "initialize": handle_initialize,
    "add_episode": handle_add_episode,
    "search": handle_search,
    "get_edges": handle_get_edges,
    "get_edge": handle_get_edge,
    "delete_edge": handle_delete_edge,
    "delete_group": handle_delete_group,
    "get_nodes": handle_get_nodes,
    "search_nodes": handle_search_nodes,
    "get_subgraph": handle_get_subgraph,
    "get_neighbors": handle_get_neighbors,
    "shutdown": handle_shutdown,
}


async def handle_request(line: str) -> dict[str, Any]:
    """Parse and dispatch a single JSON-RPC request."""
    try:
        request = json.loads(line)
    except json.JSONDecodeError as e:
        return _err(None, -32700, "Parse error", str(e))

    method = request.get("method")
    params = request.get("params", {})
    req_id = request.get("id")

    if method not in METHODS:
        return _err(req_id, -32601, f"Method not found: {method}")

    try:
        result = await METHODS[method](params)
        return _ok(req_id, result)
    except Exception as e:
        tb = traceback.format_exc()
        return _err(req_id, -32000, str(e), tb)


async def main() -> None:
    """Main loop: read JSON-RPC requests from stdin, dispatch concurrently.

    Each request runs as an independent task; responses are written when the
    handler completes and are matched by id on the Node side, so out-of-order
    responses are safe. shutdown/EOF/signal waits for in-flight tasks before
    closing the Graphiti connection.
    """
    loop = asyncio.get_event_loop()
    write_lock = asyncio.Lock()
    pending_tasks: set[asyncio.Task] = set()
    shutdown_started = False

    async def process_line(line: str) -> None:
        response = await handle_request(line)
        async with write_lock:
            _write_response(response)

    async def graceful_shutdown() -> None:
        nonlocal shutdown_started
        if shutdown_started:
            return
        shutdown_started = True
        # 等待在途任务（含 add_lock 内排队中的 add_episode）完成后再关闭连接
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)
        if state.graphiti is not None:
            try:
                await state.graphiti.close()
            except Exception:
                pass
            state.graphiti = None
        state.initialized = False

    def handle_signal() -> None:
        asyncio.ensure_future(graceful_shutdown())

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, handle_signal)
        except NotImplementedError:
            # Windows 不支持 add_signal_handler
            pass

    while True:
        try:
            line = await loop.run_in_executor(None, _read_line)
        except (asyncio.CancelledError, KeyboardInterrupt):
            break
        if line is None:
            break

        if not line.strip():
            continue

        task = asyncio.create_task(process_line(line))
        pending_tasks.add(task)
        task.add_done_callback(pending_tasks.discard)

        # Check if this was a shutdown request
        try:
            req = json.loads(line)
            if req.get("method") == "shutdown":
                break
        except (json.JSONDecodeError, AttributeError):
            pass

    # 循环结束后等待在途任务完成并关闭连接
    await graceful_shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
