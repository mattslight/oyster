# Containerisation & Deployment — Research Notes (March 2026)

> **STATUS: Future research.** v1 is local-only, single machine. Cloud/multi-tenant deployment is TBD. This captures early thinking on isolation and deployment models for when the question becomes real.

## Context

When Oyster moves beyond local-only, artifacts may need stronger isolation than browser iframes — especially for multi-tenant hosting or untrusted code execution. This doc captures the options evaluated during early architecture design.

## Artifact Isolation Technologies

| Technology | What it is | When it's relevant |
|------------|-----------|-------------------|
| **Docker Compose** | Multi-container applications from one YAML config. Each artifact gets its own container with declared ports and volumes. | First step beyond process isolation. Reasonable for managed single-user or small multi-tenant deployments. |
| **gVisor** | Google's container sandbox. Intercepts system calls for stronger isolation without full VM overhead. Used by Google Cloud Run. | Middle ground between Docker and full VM isolation. Good for untrusted code execution without microVM complexity. |
| **Kata Containers** | Lightweight VMs that run containers inside per-container virtual machines. Stronger isolation than gVisor, lighter than traditional VMs. | Similar use case to Firecracker but with a more standard container workflow. |
| **Firecracker** | AWS's microVM technology. KVM-based virtual machines with ~125ms boot time and ~5MB memory overhead per VM. Powers Lambda and Fargate. | Strongest isolation with surprisingly low overhead. Relevant if Oyster becomes a managed platform running user workloads on shared hosts. What Fly.io uses under the hood. |
| **Kubernetes** | Container orchestration across multiple machines. Auto-scaling, service discovery, rolling deployments. | Overkill unless operating at significant scale across multiple machines. |

**Early thinking:** Start with Docker Compose. Move to Firecracker or gVisor only when multi-tenant untrusted code execution becomes a real security requirement. Don't use Kubernetes unless operating hundreds of containers across a cluster.

## Deployment Models Considered

### Model A: Single Machine (Current)

Everything on one machine — surface, OpenCode, artifacts, SQLite. Correct for v1 and self-hosted power users.

### Model B: Control Plane + Per-Tenant Runtime

Separate shared infrastructure (UI, auth, billing, tenant router) from per-tenant environments (OpenCode, artifacts, data). Each tenant gets a versioned runtime image. Preserves tenant-scoped agent visibility — the isolation boundary is between tenants, which is where it should be.

### Model C: Central AI Pool + Distributed Data

Centralise AI compute, give workers on-demand access to tenant data. 100 users might only need 10 workers. Trade-off: OpenCode currently assumes local filesystem access, so this requires abstracting file operations behind an API — real engineering work.

## Key Architectural Constraint

The artifact contract (manifest + folder structure) is independent of the deployment boundary. The frontend communicates via HTTP/SSE APIs, not filesystem coupling. As long as that boundary stays clean, splitting into control plane and data plane later is a clean cut, not a rewrite.

## When to Revisit

This becomes relevant when:
- Oyster needs to run user workloads on shared infrastructure
- Multi-tenant isolation is a real security requirement
- Cloud hosting moves from "planned" to "in progress"

Until then, the single-machine model is correct and the artifact contract keeps future options open.
