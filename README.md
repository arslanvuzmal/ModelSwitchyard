<div align="center">

<img src="docs/readme-assets/omnirouter-hero.svg" alt="OmniRouter policy-driven AI control plane" width="100%" />

# OmniRouter

### AI Model Gateway, Routing &amp; Reliability Control Plane

One OpenAI-shaped endpoint for policy-driven model selection across providers. OmniRouter authenticates virtual keys, enforces usage constraints, explains every routing decision, executes bounded retry and fallback, normalizes provider behavior, and persists the evidence operators need.

[**Demo**](https://omnirouter-ai.vercel.app) Â· [**30-second model**](#30-second-mental-model) Â· [**Architecture**](#architecture) Â· [**API**](#api) Â· [**Security**](#security-architecture) Â· [**Quickstart**](#local-development)

[![Tests](https://img.shields.io/badge/tests-124-34d399?style=flat-square)](#testing) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square)](#technical-specifications) [![Next.js](https://img.shields.io/badge/Next.js-16-111827?style=flat-square)](#technical-specifications) [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=flat-square)](#data-architecture) [![License](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)

</div>

![OmniRouter operational overview showing request, routing, latency, cost, model distribution, and failure data](portfolio/screenshots/02-overview-dashboard.png)

> **Deterministic demo, real execution path.** The configured [demo deployment](https://omnirouter-ai.vercel.app) uses fictional in-process models, so routing and failure scenarios are repeatable and no prompt is sent to an external AI service. The API, playground, comparison workflow, and demo all enter the same `runCompletion` gateway path.

<details>
<summary><strong>Demo roles and guided walkthrough</strong></summary>

The repository-configured walkthrough is available at [`/demo/story`](https://omnirouter-ai.vercel.app/demo/story).

| Account | Role | Useful surface |
| --- | --- | --- |
| `owner@omnirouter.demo` | Owner | Complete workspace view |
| `admin@omnirouter.demo` | Admin | Operations without workspace deletion |
| `developer@omnirouter.demo` | Developer | Playground, prompts, development keys |
| `viewer@omnirouter.demo` | Viewer | Read-only authorization boundary |

Demo password: `OmniDemo!2026`. The seeded workspace is marked as protected and destructive demo operations are refused server-side.

</details>

## Contents

- [Why OmniRouter](#why-omnirouter) Â· [Mental model](#30-second-mental-model) Â· [Capabilities](#control-plane-capabilities)
- [Architecture](#architecture) Â· [Request lifecycle](#request-lifecycle) Â· [Routing engine](#routing-engine)
- [Routing strategies](#routing-strategies) Â· [Worked decision](#worked-routing-decision) Â· [Fallback](#failure-and-fallback-engine)
- [Providers](#provider-abstraction) Â· [Explainability](#every-routing-decision-leaves-evidence) Â· [Observability](#usage-cost-and-observability)
- [Quotas](#quotas-and-cost-controls) Â· [Virtual keys](#virtual-api-keys) Â· [Prompts](#prompt-registry)
- [Security](#security-architecture) Â· [Data](#data-architecture) Â· [Product](#product-walkthrough)
- [API](#api) Â· [Specifications](#technical-specifications) Â· [Testing](#testing)
- [Deployment](#deployment-architecture) Â· [Repository](#repository-structure) Â· [Development](#local-development) Â· [Docs](#documentation)

## 30-second mental model

Your application sends one chat-completion request. OmniRouter:

1. validates the payload and authenticates the virtual key;
2. derives workspace, application, and environment scope from that key;
3. checks key scope, expiry, and configured quotas;
4. loads the active policy and resolves recent runtime signals;
5. removes unavailable, excluded, incapable, undersized, or over-budget candidates;
6. ranks the eligible set according to the operator's strategy;
7. selects the head as primary and retains the ordered remainder as fallback;
8. executes through a provider adapter;
9. classifies any failure before deciding whether to retry, fall back, or stop;
10. bounds work by attempt and total-time budgets;
11. normalizes the successful provider response;
12. stores the route explanation, stages, attempts, usage, latency, and estimated cost;
13. returns an OpenAI-shaped response with a correlation identifier.

<img src="docs/readme-assets/model-routing-lifecycle.svg" alt="Animated OmniRouter lifecycle from request authentication through candidate evaluation, retry, fallback, and trace storage" width="100%" />

### Application view vs. operator view

| Application view | Operator view |
| --- | --- |
| `POST /api/v1/chat/completions`<br />â†“<br />assistant response | Request<br />â”œâ”€ virtual-key authentication<br />â”œâ”€ quota evaluation<br />â”œâ”€ policy and strategy<br />â”œâ”€ eligible and rejected candidates<br />â”œâ”€ primary and fallback order<br />â”œâ”€ attempt 1 â†’ timeout<br />â”œâ”€ attempt 2 â†’ timeout<br />â”œâ”€ attempt 3 â†’ fallback â†’ success<br />â””â”€ tokens, latency, estimated cost, explanation |

The caller receives one stable contract. The operator receives the complete degraded execution path.

## Why OmniRouter

Direct provider integration looks simple until model choice becomes operational policy. As applications multiply, provider calls accumulate fragmented credentials, inconsistent retries, implicit fallback behavior, duplicated cost logic, difficult migrations, and model-selection branches embedded in product code.

> ### Model selection is a policy decision, not application business logic.

OmniRouter separates those concerns. Applications express a workload; the control plane owns which eligible model should serve it and how failure is handled.

The central design choice is stronger than recording the winning model: **persist why it won**. A `RouteExplanation` accounts for the candidate set, rejection reasons, live signals, strategy, score breakdown, selected target, fallback order, and evaluation time. `RequestAttempt` rows then record execution sequence, failure categories, latency, usage, and cost. A routing decision remains inspectable after its policy changes.

## Control-plane capabilities

| Surface | Verified behavior | Why it exists |
| --- | --- | --- |
| Applications and environments | Workspace applications contain separate `DEVELOPMENT` and `PRODUCTION` environments with environment-default policies. | Consumers get isolated configuration and credentials without embedding tenant identifiers in requests. |
| Provider connections and model catalog | Seven registered adapters; model records carry context, capabilities, prices, availability, and health state. | Provider-specific configuration stops at a controlled boundary. |
| Routing policies | Eight strategies share one eligibility pipeline and produce a stored explanation. | Operators can change model-selection intent without changing application code. |
| Unified gateway | Validated OpenAI-shaped request/response contract, policy selection, idempotency for non-streaming calls, and correlation headers. | Existing clients need one stable integration surface. |
| Playground and policy comparison | Both actions call the production gateway function; deterministic fault injection is restricted to the demo provider. | Engineers can inspect selection and recovery without maintaining a second execution path. |
| Request explorer and traces | Requests, lifecycle stages, every attempt, classification, fallback, usage, and route evidence are queryable. | Degraded success is visible instead of disappearing behind a `200`. |
| Analytics | Requests, status, fallback rate, mean/P50/P95 latency, tokens, estimated cost, and model/provider/error distributions derive from stored rows. | Operations are based on execution evidence rather than synthetic charts. |
| Quotas and cost ceilings | Request, token, and estimated-cost limits across minute/day/month windows; policy-level maximum projected cost. | A rejected request stops before provider execution, while warning thresholds remain observable. |
| Virtual API keys | One-time plaintext, SHA-256 lookup, display prefix, environment/application binding, scopes, expiry, and revocation. | Applications never receive provider credentials. |
| Prompt registry | Prompt and immutable version rows with an explicit active-version pointer. | Prompt iteration is inspectable without rewriting historical versions. |
| Team roles and audit | Five server-enforced workspace roles; audit snapshots recursively redact sensitive values. | Presentation controls do not substitute for authorization or evidence. |
| Provider health | Current connection/model health and stored health-check history feed routing signals and the health dashboard. | Availability can influence selection without leaking provider logic into callers. |

## Architecture

```mermaid
flowchart LR
    subgraph Clients
        App[Customer application]
        Play[Playground]
        Compare[Policy comparison]
        Dash[Dashboard]
    end

    subgraph Entry[Identity and entry]
        API[Public API]
        Session[Session auth]
        VKey[Virtual key auth]
        Scope[Workspace scope]
    end

    subgraph Execute[Gateway execution]
        Validate[Validate and bound]
        Quota[Quota engine]
        Route[Routing engine]
        Recover[Fallback executor]
        Normalize[Response normalization]
    end

    subgraph Adapters[Provider boundary]
        Demo[Demo]
        OpenAI[OpenAI]
        Anthropic[Anthropic]
        Gemini[Gemini]
        Compatible[OpenRouter / DeepSeek / Ollama]
    end

    subgraph Data[PostgreSQL]
        Config[(Policies / models / keys / prompts)]
        Evidence[(Requests / attempts / explanations)]
        Ops[(Usage / health / audit)]
    end

    App --> API --> VKey --> Scope
    Play --> Session --> Scope
    Compare --> Session
    Dash --> Session
    Scope --> Validate --> Quota --> Route --> Recover --> Normalize
    Route --> Config
    Recover --> Demo
    Recover --> OpenAI
    Recover --> Anthropic
    Recover --> Gemini
    Recover --> Compatible
    Route --> Evidence
    Recover --> Evidence
    Normalize --> Ops
```

### Control plane vs. execution plane

```mermaid
flowchart TB
    subgraph CP[Control plane]
        Dashboard[Dashboard]
        Apps[Applications and environments]
        Providers[Providers and models]
        Policies[Policies and rules]
        Keys[Virtual keys]
        Prompts[Prompt versions]
        Quotas[Quotas]
        Team[Team and roles]
        Dashboard --> Apps
        Dashboard --> Providers
        Dashboard --> Policies
        Dashboard --> Keys
        Dashboard --> Prompts
        Dashboard --> Quotas
        Dashboard --> Team
    end

    CP -. configures .-> Gateway

    subgraph DP[Data / execution plane]
        Client[Client] --> Gateway[Gateway]
        Gateway --> Route[Evaluate route]
        Route --> Call[Execute]
        Call --> Fallback[Retry or fallback]
        Fallback --> Normalize[Normalize]
        Normalize --> Record[Record evidence]
        Record --> Response[Response]
    end
```

The control plane changes policy and scope. The execution plane consumes that configuration for each request. Neither the prompt nor arbitrary request metadata is trusted to choose a workspace.

## Request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API route
    participant K as Virtual key auth
    participant G as Gateway
    participant Q as Quota engine
    participant R as Routing engine
    participant F as Fallback executor
    participant D as Provider adapter
    participant P as Provider
    participant DB as PostgreSQL

    C->>A: POST /api/v1/chat/completions
    A->>A: 1 MB guard + Zod validation
    A->>K: Bearer or x-api-key
    K->>DB: SHA-256 key lookup
    DB-->>K: workspace + application + environment
    K-->>A: scope + default policy
    A->>DB: optional idempotency lookup
    A->>G: scoped completion input
    G->>Q: evaluate requests / tokens / cost
    alt quota rejects
        Q-->>G: REJECT
        G->>DB: store rejected request + trace
        G-->>C: 429 + correlation ID
        Note over G,P: No provider call occurs
    else quota allows or warns
        Q-->>G: ALLOW / WARN
        G->>DB: policy, candidates, recent attempt signals
        G->>R: candidates + requirements + weights
        R-->>G: primary + fallback chain + explanation
        G->>F: bounded execution chain
        F->>D: normalized completion request
        D->>P: provider-native request
        P-->>D: response or error
        D-->>F: normalized response or failure
        opt classified retry or fallback
            F->>D: next bounded attempt
        end
        F-->>G: response + attempt records
        G->>DB: request + attempts + explanation + usage
        G-->>C: OpenAI-shaped response + correlation ID
    end
```

Key invariants:

- A quota-rejected request never reaches a provider.
- Workspace, application, and environment are derived from the authenticated key or session context.
- A named policy is accepted only when it is active in the key's workspace.
- Non-streaming idempotency is workspace-scoped; a replay returns `409` with the original correlation ID.
- Provider-supplied error text is replaced by category-specific safe wording.

## Routing engine

Eligibility always precedes optimization. Every strategy uses the same filters; only the ordering step changes.

<img src="docs/readme-assets/routing-decision-anatomy.svg" alt="OmniRouter routing decision anatomy from input signals through eligibility, strategy, primary selection, fallback chain, and stored explanation" width="100%" />

```mermaid
flowchart TD
    C[Candidate] --> A{Available?}
    A -->|no| RA[reject: unavailable]
    A -->|yes| H{Health unavailable?}
    H -->|yes| RH[reject: unhealthy]
    H -->|no| X{Provider excluded?}
    X -->|yes| RX[reject: provider_excluded]
    X -->|no| P{Capability match?}
    P -->|no| RP[reject: missing_capability]
    P -->|yes| W{Context sufficient?}
    W -->|no| RW[reject: context_too_small]
    W -->|yes| M{Within cost ceiling?}
    M -->|no| RM[reject: exceeds_cost_ceiling]
    M -->|yes| E[Eligible]
    E --> S[Apply strategy]
    S --> O[Ordered candidates]
    O --> Primary[Primary]
    O --> Fallback[Fallback chain]
    Primary --> Explain[RouteExplanation]
    Fallback --> Explain
    RA --> Explain
    RH --> Explain
    RX --> Explain
    RP --> Explain
    RW --> Explain
    RM --> Explain
```

Candidates that pass filtering but rank below the winner are recorded as `not_selected` and retained for fallback. The exact rejection vocabulary is:

`disabled` Â· `unavailable` Â· `unhealthy` Â· `missing_capability` Â· `context_too_small` Â· `exceeds_cost_ceiling` Â· `not_selected` Â· `provider_excluded`

`evaluateRoute` is pure and synchronous. Database reads and rolling signals hapë}z¶‰Ëkºwµç]¥¹œ…±±•È½‘”¸ğ½Ñø(€€€€ñÑİ¥‘Ñ ôˆÔÀ”ˆøñ¥µœÍÉŒô‰Á½ÉÑ™½±¥¼½ÍÉ••¹Í¡½ÑÌ¼ÀÔµÁ±…åÉ½Õ¹¹Á¹œˆ…±Ğô‰=µ¹¥I½ÕÑ•È…Ñ•İ…äÁ±…åÉ½Õ¹ˆ€¼øñ‰È€¼øñÍÑÉ½¹œù…Ñ•İ…äÁ±…åÉ½Õ¹ğ½ÍÑÉ½¹œøƒŠP•á•ÕÑ”Ñ¡É½Õ Ñ¡”Í…µ”…Ñ•İ…ä…¹‘•±¥‰•É…Ñ•±ä•á•É¥Í”±…ÍÍ¥™¥•‘•µ¼™…¥±ÕÉ•Ì¸ğ½Ñø(€€ğ½ÑÈø(€€ñÑÈø(€€€€ñÑİ¥‘Ñ ôˆÔÀ”ˆøñ¥µœÍÉŒô‰Á½ÉÑ™½±¥¼½ÍÉ••¹Í¡½ÑÌ¼ÀàµÉ•ÅÕ•ÍĞµ¥¹ÍÁ•Ñ½È¹Á¹œˆ…±Ğô‰=µ¹¥I½ÕÑ•ÈÉ•ÅÕ•ÍĞ¥¹ÍÁ•Ñ½Èˆ€¼øñ‰È€¼øñÍÑÉ½¹œùI•ÅÕ•ÍĞ•áÁ±½É•Èğ½ÍÑÉ½¹œøƒŠP™¥±Ñ•ÈÁ•ÉÍ¥ÍÑ••á•ÕÑ¥½¹Ì…¹½Á•¸Ñ¡”•Ù¥‘•¹”‰•¡¥¹…¸½ÕÑ½µ”¸ğ½Ñø(€€€€ñÑİ¥‘Ñ ôˆÔÀ”ˆøñ¥µœÍÉŒô‰Á½ÉÑ™½±¥¼½ÍÉ••¹Í¡½ÑÌ¼ÀäµÕÍ…”µ…¹…±åÑ¥Ì¹Á¹œˆ…±Ğô‰=µ¹¥I½ÕÑ•ÈÕÍ…”…¹…±åÑ¥Ìˆ€¼øñ‰È€¼øñÍÑÉ½¹œùUÍ…”…¹…±åÑ¥Ìğ½ÍÑÉ½¹œøƒŠP½ÉÉ•±…Ñ”ÑÉ…™™¥Œ°™…±±‰…¬°±…Ñ•¹ä°Ñ½­•¸°½ÍĞ°µ½‘•°°ÁÉ½Ù¥‘•È°…¹™…¥±ÕÉ”‘¥ÍÑÉ¥‰ÕÑ¥½¹Ì¸ğ½Ñø(€€ğ½ÑÈø(ğ½Ñ…‰±”ø()Q¡”½Ù•ÉÙ¥•ÜÍÉ••¹Í¡½Ğ…ĞÑ¡”Ñ½À…¹™…±±‰…¬ÑÉ…”¥¸Ñ¡”É•±¥…‰¥±¥ÑäÍ•Ñ¥½¸½µÁ±•Ñ”Ñ¡”Í¥àÍ•±•Ñ•ÁÉ½‘ÕĞÍÕÉ™…•Ìì…±°…É”•á¥ÍÑ¥¹œÉ•Á½Í¥Ñ½Éä…ÍÍ•ÑÌÉ…Ñ¡•ÈÑ¡…¸µ…¹Õ™…ÑÕÉ•ÍÉ••¹Ì¸((ŒŒA$((ŒŒŒ¡…Ğ½µÁ±•Ñ¥½¸()‰…Í )ÕÉ°€µ`A=MP¡ÑÑÁÌè¼½å½ÕÈµ‘•Á±½åµ•¹Ğ¹•á…µÁ±”½…Á¤½ØÄ½¡…Ğ½½µÁ±•Ñ¥½¹Ìp(€€µ €‰ÕÑ¡½É¥é…Ñ¥½¸è	•…É•È€‘=59%I=UQI}-dˆp(€€µ €‰½¹Ñ•¹ĞµQåÁ”è…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆp(€€µ €‰%‘•µÁ½Ñ•¹äµ-•äèÑ¥­•Ğ´ĞàÈÄµÍÕµµ…Éäˆp(€€µ€ì(€€€€‰µ•ÍÍ…•Ìˆèl(€€€€€ì€‰É½±”ˆè€‰ÍåÍÑ•´ˆ°€‰½¹Ñ•¹Ğˆè€‰e½Ô…É”„½¹¥Í”ÍÕÁÁ½ÉĞ…ÍÍ¥ÍÑ…¹Ğ¸ˆô°(€€€€€ì€‰É½±”ˆè€‰ÕÍ•Èˆ°€‰½¹Ñ•¹Ğˆè€‰MÕµµ…É¥é”Ñ¡¥ÌÍÕÁÁ½ÉĞÑ¡É•…¸ˆô(€€€t°(€€€€‰µ…á}Ñ½­•¹Ìˆè€ĞÀÀ°(€€€€‰Ñ•µÁ•É…ÑÕÉ”ˆè€À¸È°(€€€€‰Á½±¥äˆè€‰	…±…¹•ÁÉ½‘ÕÑ¥½¸ˆ(€ôœ)€()Q¡”­•äµ…ä…±Í¼‰”ÍÕÁÁ±¥•…Ìàµ…Á¤µ­•å€¸µ½‘•±€Á¥¹Ì„µ½‘•°…¹Íİ¥Ñ¡•ÌÉ½ÕÑ¥¹œÑ¼59U1€ìÁ½±¥å€Í•±•ÑÌ…¸…Ñ¥Ù”Á½±¥ä¥¸Ñ¡”…ÕÑ¡•¹Ñ¥…Ñ•İ½É­ÍÁ…”¸É•ÍÁ½¹Í•}™½Éµ…Ñ€…•ÁÑÌì€‰ÑåÁ”ˆè€‰©Í½¹}Í¡•µ„ˆ°€‰©Í½¹}Í¡•µ„ˆèì€‰Í¡•µ„ˆèì€¸¸¸ôôõ€¸()©Í½¸)ì(€€‰¥ˆè€‰•ÄäÀÔàÀµ™ÀÄ´ĞÑ„Ì´å”ĞØµ•ˆÈÁ™”İ˜ĞÌÕ”ˆ°(€€‰½‰©•Ğˆè€‰¡…Ğ¹½µÁ±•Ñ¥½¸ˆ°(€€‰É•…Ñ•ˆè€ÄÜàÜÄàĞÀÀÀ°(€€‰µ½‘•°ˆè€‰…ÍÑÉ„µ™…ÍĞˆ°(€€‰¡½¥•Ìˆèl(€€€ì(€€€€€€‰¥¹‘•àˆè€À°(€€€€€€‰µ•ÍÍ…”ˆèì€‰É½±”ˆè€‰…ÍÍ¥ÍÑ…¹Ğˆ°€‰½¹Ñ•¹Ğˆè€‹Š˜ˆô°(€€€€€€‰™¥¹¥Í¡}É•…Í½¸ˆè€‰ÍÑ½Àˆ(€€€ô(€t°(€€‰ÕÍ…”ˆèì(€€€€‰ÁÉ½µÁÑ}Ñ½­•¹Ìˆè€ÄÀ°(€€€€‰½µÁ±•Ñ¥½¹}Ñ½­•¹Ìˆè€ØÌ°(€€€€‰Ñ½Ñ…±}Ñ½­•¹Ìˆè€ÜÌ(€ô°(€€‰½µ¹¥É½ÕÑ•Èˆèì(€€€€‰½ÉÉ•±…Ñ¥½¹}¥ˆè€‰•ÄäÀÔàÀµ™ÀÄ´ĞÑ„Ì´å”ĞØµ•ˆÈÁ™”İ˜ĞÌÕ”ˆ°(€€€€‰ÁÉ½Ù¥‘•Èˆè€‰5<ˆ°(€€€€‰™…±±‰…­}ÕÍ•ˆè™…±Í”°(€€€€‰…ÑÑ•µÁÑÌˆè€Ä°(€€€€‰•ÍÑ¥µ…Ñ•‘}½ÍĞˆè€À¸ÀÀÀÀÌä°(€€€€‰±…Ñ•¹å}µÌˆè€ÔĞÀ°(€€€€‰Á½±¥äˆè€‰	…±…¹•ÁÉ½‘ÕÑ¥½¸ˆ°(€€€€‰ÍÑÉ…Ñ•äˆè€‰	19ˆ°(€€€€‰É½ÕÑ¥¹}É•…Í½¸ˆè€‰ÍÑÉ„…ÍĞÍ½É•¡¥¡•ÍĞ……¥¹ÍĞÑ¡”½¹™¥ÕÉ•Í½É¥¹œÁ½±¥ä¸ˆ(€ô)ô)€()MÕ•ÍÌ…¹Á½ÍĞµ…ÕÑ¡•¹Ñ¥…Ñ¥½¸™…¥±ÕÉ”É•ÍÁ½¹Í•Ì…ÉÉäè()Ñ•áĞ)àµ½µ¹¥É½ÕÑ•Èµ½ÉÉ•±…Ñ¥½¸µ¥è€ñÕÕ¥ø)àµ½µ¹¥É½ÕÑ•Èµ™…±±‰…¬µÕÍ•è€ÑÉÕ”ğ™…±Í”)àµ½µ¹¥É½ÕÑ•Èµ…ÑÑ•µÁÑÌè€€€€€€€ñ½Õ¹Ğø)àµ½µ¹¥É½ÕÑ•ÈµÅÕ½Ñ„µİ…É¹¥¹œè€€ñ‘•Ñ…¥°ø€€€Œİ¡•¸…ÁÁ±¥…‰±”)€()Q¡•Í”½µ¹¥É½ÕÑ•É€¹…µ•Ì…É”Á…ÉĞ½˜Ñ¡”ÕÉÉ•¹ĞA$½¹ÑÉ…Ğ…¹…É”¥¹Ñ•¹Ñ¥½¹…±±äÁÉ•Í•ÉÙ•¸((ŒŒŒMÑÉ•…µ¥¹œ()A=MP€½…Á¤½ØÄ½¡…Ğ½½µÁ±•Ñ¥½¹Ì½ÍÑÉ•…µ€É•ÅÕ¥É•Ì€‰ÍÑÉ•…´ˆèÑÉÕ•€…¹É•ÑÕÉ¹ÌM•ÉÙ•ÈµM•¹ĞÙ•¹ÑÌ¸MÑÉ•…µ¥¹œ•µ¥ÑÌ¹½Éµ…±¥é•ì€‰‘•±Ñ„ˆ°€‰‘½¹”ˆõ€¡Õ¹­Ì…¹„Ñ•Éµ¥¹…°•Ù•¹Ğ°ÕÍ•ÌÑ¡”Í…µ”­•ä½Á½±¥ä½ÅÕ½Ñ„½É½ÕÑ¥¹œÁ…Ñ °Á•ÉÍ¥ÍÑÌ¥ÑÌ•á•ÕÑ¥½¸ÑÉ…”°…¹‘½•Ì¹½Ğ…•ÁĞ%‘•µÁ½Ñ•¹äµ-•å€¸()Õ±°½¹ÑÉ…ĞèmA$I•™•É•¹•t¡‘½Ì½A%}II9¹µ¤¸((ŒŒQ•¡¹¥…°ÍÁ•¥™¥…Ñ¥½¹Ì((ñ‘•Ñ…¥±Ì½Á•¸ø(ñÍÕµµ…ÉäøñÍÑÉ½¹œù…Ñ•İ…ä…¹É½ÕÑ¥¹œğ½ÍÑÉ½¹œøğ½ÍÕµµ…Éäø()ğÉ•„ğMÁ•¥™¥…Ñ¥½¸ğ)ğ€´´´ğ€´´´ğ)ğA$ÍÑå±”ğ=Á•¹$µÍ¡…Á•¹½¸µÍÑÉ•…µ¥¹œÉ•ÍÁ½¹Í”Á±ÕÌ¹…µ•ÍÁ…•½µ¹¥É½ÕÑ•É€É½ÕÑ¥¹œµ•Ñ…‘…Ñ„ğ)ğI•ÅÕ•ÍĞÙ…±¥‘…Ñ¥½¸ği½ì€Ä5‘•±…É•‰½‘äì•áÁ±¥¥Ğ…ÉÉ…ä°ÍÑÉ¥¹œ°…¹•¹•É…Ñ¥½¸‰½Õ¹‘Ìğ)ğÕÑ¡•¹Ñ¥…Ñ¥½¸ğY¥ÉÑÕ…°­•äÑ¡É½Õ 	•…É•È½Èàµ…Á¤µ­•å€ìM!´ÈÔØ‘…Ñ…‰…Í”±½½­ÕÀğ)ğQ•¹…¹ĞÍ½Á”ğ]½É­ÍÁ…”½…ÁÁ±¥…Ñ¥½¸½•¹Ù¥É½¹µ•¹Ğ‘•É¥Ù•™É½´…ÕÑ¡•¹Ñ¥…Ñ•½¹Ñ•áĞğ)ğ%‘•µÁ½Ñ•¹äğ=ÁÑ¥½¹…°¹½¸µÍÑÉ•…µ¥¹œ%‘•µÁ½Ñ•¹äµ-•å€ì…Ğµµ½ÍĞµ½¹”±½½­ÕÀÁ•Èİ½É­ÍÁ…”ìÉ•Á±…ä€ĞÀå€ğ)ğMÑÉ•…µ¥¹œğ•‘¥…Ñ•MMÉ½ÕÑ”…Ğ€½…Á¤½ØÄ½¡…Ğ½½µÁ±•Ñ¥½¹Ì½ÍÑÉ•…µ€ì¥‘•µÁ½Ñ•¹ä¥Ì¥¹Ñ•¹Ñ¥½¹…±±äÉ•©•Ñ•½¸Ñ¡¥ÌÉ½ÕÑ”ğ)ğMÑÉ…Ñ•¥•Ìğ¥¡Ğèµ…¹Õ…°°ÁÉ¥½É¥Ñä°İ•¥¡Ñ•°½ÍĞ°±…Ñ•¹ä°É•±¥…‰¥±¥Ñä°…Á…‰¥±¥Ñä°‰…±…¹•ğ)ğ±¥¥‰¥±¥ÑäğÙ…¥±…‰¥±¥Ñä°Õ¹…Ù…¥±…‰±”¡•…±Ñ °ÁÉ½Ù¥‘•È•á±ÕÍ¥½¸°…Á…‰¥±¥Ñ¥•Ì°½¹Ñ•áĞ°ÁÉ½©•Ñ•µ½ÍĞ•¥±¥¹œğ)ğ1¥Ù”Í¥¹…±Ìğ!•…±Ñ ÍÑ…Ñ”°É••¹ĞÍÕ•ÍÍ™Õ°µ•…¸±…Ñ•¹ä°É••¹ĞÍÕ•ÍÌÉ…Ñ”°Í…µÁ±”Í¥é”ğ)ğáÁ±…¹…Ñ¥½¸ğ±°…¹‘¥‘…Ñ•Ì°É•©•Ñ¥½¹Ì°Í•±•Ñ•…¹‘¥‘…Ñ”°Í½É”½µÁ½¹•¹ÑÌ°É•…Í½¸°™…±±‰…¬½É‘•È°Ñ¥µ”ğ((ğ½‘•Ñ…¥±Ìø((ñ‘•Ñ…¥±Ìø(ñÍÕµµ…ÉäøñÍÑÉ½¹œùI•±¥…‰¥±¥Ñä…¹½‰Í•ÉÙ…‰¥±¥Ñäğ½ÍÑÉ½¹œøğ½ÍÕµµ…Éäø()ğÉ•„ğMÁ•¥™¥…Ñ¥½¸ğ)ğ€´´´ğ€´´´ğ)ğ…¥±ÕÉ”Ñ…á½¹½µäğ€ÄÌ…Ñ•½É¥•Ì¥¹±Õ‘¥¹œ±¥•¹Ğ…¹•±±…Ñ¥½¸ğ)ğI•ÑÉäÁ½±¥äğA•È…Ñ•½ÉäìÉ•ÑÉå…‰±”…Ñ•½É¥•Ì…±±½Ü…Ğµ½ÍĞ½¹”Í…µ”µÑ…É•ĞÉ•ÑÉäğ)ğ…±±‰…¬ğ=É‘•É•É•µ…¥¹‘•È™É½´Ñ¡”É½ÕÑ¥¹œ‘•¥Í¥½¸ì‰±½­•™½È¥¹Ù…±¥É•ÅÕ•ÍĞ°Í…™•ÑäÉ•™ÕÍ…°°ÅÕ½Ñ„°…¹•±±…Ñ¥½¸ğ)ğ	½Õ¹‘ÌğA½±¥äµ…à…ÑÑ•µÁÑÌ€ÇŠLÙ€ìÁ•Èµ…ÑÑ•µÁĞÑ¥µ•½ÕĞ€ÇŠLÄÈÀÍ€ìÑ½Ñ…°Ñ¥µ•½ÕĞ€ÇŠLÌÀÀÍ€ğ)ğ	…­½™˜ğáÁ½¹•¹Ñ¥…°•¥±¥¹œİ¥Ñ ™Õ±°©¥ÑÑ•ÈìÁÉ½Ù¥‘•ÈÉ•ÑÉå™Ñ•É5Í€Ñ…­•ÌÁÉ••‘•¹”ğ)ğQÉ…”ğ=É‘•É•±¥™•å±”ÍÑ…•ÌÁ±ÕÌÉ•ÅÕ•ÍĞ…¹…ÑÑ•µÁĞÉ½İÌğ)ğ5•ÑÉ¥ÌğMÑ…ÑÕÌ°™…±±‰…¬°…Ù•É…”½@ÔÀ½@äÔ±…Ñ•¹ä°Ñ½­•¹Ì°•ÍÑ¥µ…Ñ•½ÍĞ°µ½‘•°½ÁÉ½Ù¥‘•È½…ÁÁ±¥…Ñ¥½¸½•ÉÉ½È‘¥ÍÑÉ¥‰ÕÑ¥½¹Ìğ)ğUÍ…”ğAÉ½Ù¥‘•ÈÕÍ…”ÁÉ•™•ÉÉ•ì¡•ÕÉ¥ÍÑ¥Œ•ÍÑ¥µ…Ñ”ÕÍ•İ¡•¸…‰Í•¹ĞìÍÕ•ÍÍ™Õ°…ÑÑ•µÁĞ¥Ì‰¥±±…‰±”¥¸Ñ¡”…Ñ•İ…äµ½‘•°ğ((ğ½‘•Ñ…¥±Ìø((ñ‘•Ñ…¥±Ìø(ñÍÕµµ…ÉäøñÍÑÉ½¹œùM•ÕÉ¥Ñä…¹‘…Ñ„ğ½ÍÑÉ½¹œøğ½ÍÕµµ…Éäø()ğÉ•„ğMÁ•¥™¥…Ñ¥½¸ğ)ğ€´´´ğ€´´´ğ)ğA…ÍÍİ½É‘ÌğÍÉåÁĞ°Í…±Ñ•°•µ‰•‘‘•Á…É…µ•Ñ•ÉÌ°Ñ¥µ¥¹œµÍ…™”Ù•É¥™¥…Ñ¥½¸ğ)ğM•ÍÍ¥½¹Ìğ…Ñ…‰…Í”µ‰…­•½Á…ÅÕ”Ñ½­•¸°M!´ÈÔØÍÑ½É•°Í•Ù•¸µ‘…ä¡ÑÑÁ=¹±å€½½­¥”ğ)ğY¥ÉÑÕ…°­•åÌğM!´ÈÔØÍÑ½É•°½¹”µÑ¥µ”Á±…¥¹Ñ•áĞ°Í½Á•Ì°•áÁ¥Éä°É•Ù½…Ñ¥½¸°…ÁÀ½•¹Ù¥É½¹µ•¹Ğ‰¥¹‘¥¹œğ)ğAÉ½Ù¥‘•ÈÉ•‘•¹Ñ¥…±ÌğL´ÈÔØµ4İ¥Ñ É…¹‘½´€ÄÈµ‰åÑ”%X…¹…ÕÑ¡•¹Ñ¥…Ñ¥½¸Ñ…œğ)ğQ•¹…¹Ğ¥Í½±…Ñ¥½¸ğ%¹‘•á•İ½É­ÍÁ…•%‘€½İ¹•ÉÍ¡¥À…¹Í•ÉÙ•ÈµÉ•Í½±Ù•Í½Á”ğ)ğI	ğ¥Ù”É½±•Ì…¹É…¹Õ±…ÈÍ•ÉÙ•ÈµÍ¥‘”Á•Éµ¥ÍÍ¥½¹Ìğ)ğ•™…Õ±ĞÉ•Ñ•¹Ñ¥½¸ğ5•Ñ…‘…Ñ„µ½¹±äÉ•ÅÕ•ÍĞ±½¥¹œÁ…Ñ ğ)ğÕ‘¥ĞğI•‘…Ñ•)M=8Í¹…ÁÍ¡½ÑÌì¹¼ÕÁ‘…Ñ”½‘•±•Ñ”¡•±Á•È¥¸Ñ¡”…ÁÁ±¥…Ñ¥½¸µ½‘Õ±”ğ)ğ…Ñ…‰…Í”ğA½ÍÑÉ•ME0€ÄØìAÉ¥Íµ„€Üİ¥Ñ Ñ¡”Á€‘É¥Ù•È…‘…ÁÑ•Èì€ÈÔÍ¡•µ„µ½‘•±Ìğ)ğ)M=8ÕÍ…”ğY…É¥…‰±”Á½±¥ä°ÑÉ…”°•áÁ±…¹…Ñ¥½¸°ÁÉ½µÁĞÑ•ÍĞ°…¹…Õ‘¥ĞÍÑÉÕÑÕÉ•Ì½¹±äğ((ğ½‘•Ñ…¥±Ìø((ñ‘•Ñ…¥±Ìø(ñÍÕµµ…ÉäøñÍÑÉ½¹œùMÑ…¬ğ½ÍÑÉ½¹œøğ½ÍÕµµ…Éäø()ğ1…å•ÈğY•É¥™¥•¡½¥”ğ)ğ€´´´ğ€´´´ğ)ğÉ…µ•İ½É¬ğ9•áĞ¹©Ì€ÄØ¸È¸ÄÉ€°ÁÀI½ÕÑ•È°9½‘”¹©ÌÉ½ÕÑ”ÉÕ¹Ñ¥µ”ğ)ğU$ğI•…Ğ€Ää¸È¸á€°Q…¥±İ¥¹ML€Ğ¸Ì¸Í€°I•¡…ÉÑÌ°1Õ¥‘”ğ)ğ1…¹Õ…”ğQåÁ•MÉ¥ÁĞ€Ø¸À¸Í€°ÍÑÉ¥Ñ€°¹½U¹¡•­•‘%¹‘•á•‘•ÍÍ€°¹½%µÁ±¥¥Ñ=Ù•ÉÉ¥‘•€ğ)ğY…±¥‘…Ñ¥½¸ği½€Ğ¸Ğ¸Í€ğ)ğ…Ñ„ğA½ÍÑÉ•ME0€ÄØ°AÉ¥Íµ„€Ü¸ä¸Å€°ÁÉ¥Íµ„½…‘…ÁÑ•ÈµÁ€ğ)ğQ•ÍÑÌğY¥Ñ•ÍĞ€Ğ¸Ä¸ÄÁ€ìA±…åİÉ¥¡Ğ€Ä¸ØÈ¸Å€¥ÌÁÉ•Í•¹Ğ…Ì„‘•Ù•±½Áµ•¹Ğ‘•Á•¹‘•¹äğ)ğ$ğ¥Ñ!ÕˆÑ¥½¹Ì½¸9½‘”¹©Ì€ÈÈİ¥Ñ A½ÍÑÉ•ME0€ÄØÍ•ÉÙ¥”ğ)ğ½Õµ•¹Ñ•‘•Á±½åµ•¹ĞğY•É•°…ÁÁ±¥…Ñ¥½¸€¬MÕÁ…‰…Í”A½ÍÑÉ•ME0ğ((ğ½‘•Ñ…¥±Ìø((ŒŒQ•ÍÑ¥¹œ()Q¡”ÕÉÉ•¹ĞÑ•ÍĞ™¥±•Ì‘•±…É”€¨¨ÄÈĞÑ•ÍĞ…Í•Ì¨¨è()ğMÕ¥Ñ”ğ½Õ¹Ğğ%µÁ½ÉÑ…¹Ğ¥¹Ù…É¥…¹ÑÌ•á•É¥Í•ğ)ğ€´´´ğ€´´´èğ€´´´ğ)ğU¹¥Ğğ€àÜğ±¥¥‰¥±¥Ñä…¹…±°•¥¡ĞÍÑÉ…Ñ•¥•Ìì½µÁ±•Ñ”…¹‘¥‘…Ñ”…½Õ¹Ñ¥¹œì‰½Õ¹‘•™…±±‰…¬ì±…ÍÍ¥™¥…Ñ¥½¸ì©¥ÑÑ•ÈìÑ½­•¸½½ÍĞµ…Ñ ì•¹ÉåÁÑ¥½¸ìÁ…ÍÍİ½É‘ÌìÙ¥ÉÑÕ…°­•åÌìI	ìÉ•‘…Ñ¥½¸ğ)ğ%¹Ñ•É…Ñ¥½¸ğ€ÄĞğ…Ñ•İ…äÁ•ÉÍ¥ÍÑ•¹”ìÉ½ÕÑ”•áÁ±…¹…Ñ¥½¸…¹ÑÉ…”ì‘•Ñ•Éµ¥¹¥ÍÑ¥Œ‘•µ¼½ÕÑÁÕĞìµ•Ñ…‘…Ñ„µ½¹±ä±½¥¹œìÉ•ÑÉä½™…±±‰…¬ìÍ…™•ÑäÉ•™ÕÍ…°ìÕÍ…”É½±±ÕÀìÅÕ½Ñ„É•©•Ñ¥½¸½İ…É¹¥¹œğ)ğM•ÕÉ¥Ñäğ€ÈÌğ]½É­ÍÁ…”¥Í½±…Ñ¥½¸ìÍ½Á•Á½±¥ä½…ÁÁ±¥…Ñ¥½¸±½½­ÕÀì­•ä¥¹‘¥ÍÑ¥¹Õ¥Í¡…‰¥±¥Ñäì¥Á¡•ÉÑ•áĞÍÑ½É…”ìÉ•ÅÕ•ÍĞ‰½Õ¹‘ÌìÁÉ½µÁĞÑ•áĞ…¹¹½Ğ…±Ñ•ÈÉ½ÕÑ¥¹œìÍ…™”•ÉÉ½ÉÌğ()Q¡”Í••Ù•É¥™¥•È…‘‘Ì€¨¨Äà¹…µ•¡•­Ì¨¨½Ù•É¥¹œ…½Õ¹ÑÌ°…ÁÁ±¥…Ñ¥½¹Ì°Á½±¥¥•Ì°‘•µ¼µ½‘•±Ì°Ù¥ÉÑÕ…°­•åÌ°ÅÕ½Ñ…Ì°ÁÉ½µÁÑÌ°Í••‘•É•ÅÕ•ÍÑÌ°™…±±‰…¬°Ñ•Éµ¥¹…°™…¥±ÕÉ”°É½ÕÑ”•Ù¥‘•¹”°…ÑÑ•µÁÑÌ°Í…™•ÑäÉ•™ÕÍ…°°…¹µ•Ñ…‘…Ñ„µ½¹±ä±½¥¹œ¸()‰…Í )¹Á´ÉÕ¸Ñ•ÍĞ€€€€€€€€€€€€€€Œ€àÜÕ¹¥ĞÑ•ÍÑÌ)¹Á´ÉÕ¸Ñ•ÍĞé¥¹Ñ•É…Ñ¥½¸€€Œ€ÄĞ¥¹Ñ•É…Ñ¥½¸Ñ•ÍÑÌìA½ÍÑÉ•ME0É•ÅÕ¥É•)¹Á´ÉÕ¸Ñ•ÍĞéÍ•ÕÉ¥Ñä€€€€€Œ€ÈÌÍ•ÕÉ¥ÑäÑ•ÍÑÌìA½ÍÑÉ•ME0É•ÅÕ¥É•)¹Á´ÉÕ¸‘•µ¼éÙ•É¥™ä€€€€€€€Œ€ÄàÍ••‘•µ‘•µ¼¡•­Ì)¹Á´ÉÕ¸Ù•É¥™ä€€€€€€€€€€€€Œ™½Éµ…Ğ€¬±¥¹Ğ€¬ÑåÁ•Ì€¬Õ¹¥Ğ€¬ÁÉ½‘ÕÑ¥½¸‰Õ¥±)€()$…‘‘¥Ñ¥½¹…±±ä•¹•É…Ñ•ÌAÉ¥Íµ„°…ÁÁ±¥•Ìµ¥É…Ñ¥½¹Ì°ÉÕ¹Ì…±°Ñ¡É•”Ñ•ÍĞÁÉ½©•ÑÌ°Í••‘Ì…¹Ù•É¥™¥•ÌÑ¡”‘•µ½¹ÍÑÉ…Ñ¥½¸°…¹É•…Ñ•Ì„ÁÉ½‘ÕÑ¥½¸‰Õ¥±……¥¹ÍĞ…¸•Á¡•µ•É…°A½ÍÑÉ•ME0€ÄØÍ•ÉÙ¥”¸((ŒŒ•Á±½åµ•¹Ğ…É¡¥Ñ•ÑÕÉ”()Q¡”É•Á½Í¥Ñ½Éä‘½Õµ•¹ÑÌÑ¡¥ÌÉ•±•…Í”Á…Ñ è()Ñ•áĞ)¥Ñ!Õˆ+ŠRsŠR ¥Ñ!ÕˆÑ¥½¹ÌƒŠH9½‘”¹©Ì€ÈÈƒŠHA½ÍÑÉ•ME0€ÄØÍ•ÉÙ¥”ƒŠHÙ•É¥™ä€¬‘•µ¼¡•¬€¬‰Õ¥±+ŠRSŠR Y•É•°€€€€€€€€ƒŠH9•áĞ¹©Ì…ÁÁ±¥…Ñ¥½¸ƒŠHÁ½½±•Q	M}UI0(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ƒŠRSŠR MÕÁ…‰…Í”A½ÍÑÉ•ME0(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ƒŠRSŠR ‘¥É•Ğ%IQ}UI0™½Èµ¥É…Ñ¥½¹Ì)€()IÕ¹Ñ¥µ”ÕÍ•ÌÑ¡”Á½½±•‘…Ñ…‰…Í”½¹¹•Ñ¥½¸ìAÉ¥Íµ„5¥É…Ñ”ÕÍ•ÌÑ¡”‘¥É•Ğ½¹¹•Ñ¥½¸‰•…ÕÍ”0µÕÍĞ‰åÁ…ÍÌÑ¡”Á½½±•È¸…Í¡‰½…ÉÉ½ÕÑ•Ì…É”‘å¹…µ¥Œ‰•…ÕÍ”Ñ¡•äÉ•…±¥Ù”İ½É­ÍÁ…”‘…Ñ„¸Q¡”‘•µ¼Í••¥Ì•áÁ±¥¥Ğ°É•™ÕÍ•ÌÑ¼ÉÕ¸İ¡•¸5=}5=õ™…±Í•€°…¹¥Ì¹•Ù•ÈÁ…ÉĞ½˜•Ù•Éä‰Õ¥±¸()M•”m•Á±½åµ•¹Ñt¡‘½Ì½A1=e59P¹µ¤™½È•¹Ù¥É½¹µ•¹ĞÍ•ÑÕÀ…¹½Á•É…Ñ¥¹œ¡•­Ì¸((ŒŒI•Á½Í¥Ñ½ÉäÍÑÉÕÑÕÉ”()Ñ•áĞ)=µ¹¥I½ÕÑ•È¼+ŠRsŠRŠR …ÁÀ¼+ŠR€€ƒŠRsŠRŠR €¡‘…Í¡‰½…É¤½‘…Í¡‰½…É¼€€€€€€€€Œ½Á•É…Ñ½ÈÍÕÉ™…•Ì+ŠR€€ƒŠRsŠRŠR …Á¤½ØÄ½¡…Ğ½½µÁ±•Ñ¥½¹Ì¼€€€€€€ŒÕ¹¥™¥•…¹MM…Ñ•İ…äÉ½ÕÑ•Ì+ŠR€€ƒŠRSŠRŠR ‘•µ¼¼€€€€€€€€€€€€€€€€€€€€€€€€€Œ‘•Ñ•Éµ¥¹¥ÍÑ¥ŒÕ¥‘•İ½É­™±½İÌ+ŠRsŠRŠR ½µÁ½¹•¹ÑÌ¼€€€€€€€€€€€€€€€€€€€€€€€Œ‘…Í¡‰½…É…¹‘•Í¥¸µÍåÍÑ•´½µÁ½¹•¹ÑÌ+ŠRsŠRŠR ±¥ˆ¼+ŠR€€ƒŠRsŠRŠR …¤¼+ŠR€€ƒŠR€€ƒŠRsŠRŠR É½ÕÑ¥¹œ¼€€€€€€€€€€€€€€€€€€ŒÁÕÉ”•±¥¥‰¥±¥Ñä…¹É…¹­¥¹œ+ŠR€€ƒŠR€€ƒŠRsŠRŠR ™…±±‰…¬¼€€€€€€€€€€€€€€€€€Œ‰½Õ¹‘•±…ÍÍ¥™¥•É•½Ù•Éä+ŠR€€ƒŠR€€ƒŠRSŠRŠR ÁÉ½Ù¥‘•ÉÌ¼€€€€€€€€€€€€€€€€Œ…‘…ÁÑ•È‰½Õ¹‘…Éä+ŠR€€ƒŠRsŠRŠR …Á¤µ­•åÌ¼€€€€€€€€€€€€€€€€€€€€€ŒÙ¥ÉÑÕ…°µ­•ä•¹•É…Ñ¥½¸…¹…ÕÑ +ŠR€€ƒŠRsŠRŠR …ÕÑ ¼€€€€€€€€€€€€€€€€€€€€€€€€€ŒÍ•ÍÍ¥½¹Ì°Á…ÍÍİ½É‘Ì°Õ…É‘Ì+ŠR€€ƒŠRsŠRŠR ÅÕ½Ñ…Ì¼€€€€€€€€€€€€€€€€€€€€€€€ŒÁÉ”µÁÉ½Ù¥‘•ÈÕÍ…”•Ù…±Õ…Ñ¥½¸+ŠR€€ƒŠRsŠRŠR …¹…±åÑ¥Ì¼€€€€€€€€€€€€€€€€€€€€ŒÁ•ÉÍ¥ÍÑ•½Á•É…Ñ¥½¹…°ÅÕ•É¥•Ì+ŠR€€ƒŠRsŠRŠR …Õ‘¥Ğ¼€€€€€€€€€€€€€€€€€€€€€€€€Œ…ÁÁ•¹µ½¹±äİÉ¥Ñ•Ì…¹É•‘…Ñ¥½¸+ŠR€€ƒŠRSŠRŠR Á•Éµ¥ÍÍ¥½¹Ì¼€€€€€€€€€€€€€€€€€€ŒÉ½±”µÑ¼µÁ•Éµ¥ÍÍ¥½¸Á½±¥ä+ŠRsŠRŠR ÁÉ¥Íµ„¼€€€€€€€€€€€€€€€€€€€€€€€€€€€Œ€ÈÔµµ½‘•°Í¡•µ„°µ¥É…Ñ¥½¸°Í••Í•¹…É¥½Ì+ŠRsŠRŠR Ñ•ÍÑÌ¼€€€€€€€€€€€€€€€€€€€€€€€€€€€€ŒÕ¹¥Ğ°¥¹Ñ•É…Ñ¥½¸°Í•ÕÉ¥Ñä+ŠRsŠRŠR Á½ÉÑ™½±¥¼½ÍÉ••¹Í¡½ÑÌ¼€€€€€€€€€€€€ŒÉ•…°ÁÉ½‘ÕĞ…ÁÑÕÉ•Ì+ŠRSŠRŠR ‘½Ì¼€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Œ…É¡¥Ñ•ÑÕÉ”…¹½Á•É…Ñ¥¹œÉ•™•É•¹•Ì)€((ŒŒ1½…°‘•Ù•±½Áµ•¹Ğ()AÉ•É•ÅÕ¥Í¥Ñ•Ìè9½‘”¹©Ì€ÈÈ°¹Á´°½­•È°…¹¥Ğ¸()‰…Í )¥Ğ±½¹”¡ÑÑÁÌè¼½¥Ñ¡Õˆ¹½´½…ÉÍ±…¹ÙÕéµ…°½5½‘•±Mİ¥Ñ¡å…É¹¥Ğ½µ¹¥É½ÕÑ•È)½µ¹¥É½ÕÑ•È)¹Á´¤()À€¹•¹Ø¹•á…µÁ±”€¹•¹Ø(ŒI•Á±…”UQ!}MIP°9IeAQ%=9}-d°…¹%9QI91}A%}MIP¸(Œ9IeAQ%=9}-dµÕÍĞ‘•½‘”Ñ¼•á…Ñ±ä€ÌÈ‰åÑ•Ì¸()¹Á´ÉÕ¸‘ˆéÕÀ€€€€€€€ŒA½ÍÑÉ•ME0€ÄØ…Ğ±½…±¡½ÍĞèÔĞÌÔ)¹Á´ÉÕ¸‘ˆé‘•Á±½ä€€€Œ…ÁÁ±ä½µµ¥ÑÑ•µ¥É…Ñ¥½¹Ì)¹ÁàÑÍàÁÉ¥Íµ„½Í••½¥¹‘•à¹ÑÌ)¹Á´ÉÕ¸‘•Ø)€()=Á•¸€ñ¡ÑÑÀè¼½±½…±¡½ÍĞèÌÀÀÀø…¹ÕÍ”Ñ¡”Í••‘•‘•µ¼…½Õ¹Ğ¸9¼•áÑ•É¹…°ÁÉ½Ù¥‘•È­•ä¥ÌÉ•ÅÕ¥É•İ¡¥±”5=}5=õÑÉÕ•€¸((ñ‘•Ñ…¥±Ìø(ñÍÕµµ…ÉäøñÍÑÉ½¹œù¹Ù¥É½¹µ•¹ĞÙ…É¥…‰±•Ìğ½ÍÑÉ½¹œøğ½ÍÕµµ…Éäø()ğY…É¥…‰±”ğI•ÅÕ¥É•‰äÕÉÉ•¹ĞÍ•ÑÕÀğAÕÉÁ½Í”ğ)ğ€´´´ğ€´´´èğ€´´´ğ)ğQ	M}UI1€ğe•ÌğIÕ¹Ñ¥µ”A½ÍÑÉ•ME0½¹¹•Ñ¥½¸ìÁ½½±•¥¸Ñ¡”‘½Õµ•¹Ñ•Í•ÉÙ•É±•ÍÌ‘•Á±½åµ•¹Ğğ)ğ%IQ}UI1€ğe•Ìğ¥É•Ğ½¹¹•Ñ¥½¸ÕÍ•‰äAÉ¥Íµ„5¥É…Ñ”ğ)ğUQ!}MIQ€ğe•Ìğ5¥¹¥µÕ´€ÌÈµ¡…É…Ñ•ÈÍ•ÉÙ•ÈÍ•É•ĞÕÍ•Ñ¼Í…±Ğ%@½ÉÉ•±…Ñ¥½¸¡…Í¡•Ìğ)ğ9IeAQ%=9}-e€ğe•Ìğ	…Í”ØĞÙ…±Õ”‘•½‘¥¹œÑ¼•á…Ñ±ä€ÌÈ‰åÑ•Ì™½ÈL´ÈÔØµ4ğ)ğ%9QI91}A%}MIQ€ğQ•µÁ±…Ñ”ğ5…¥¹Ñ•¹…¹”•¹‘Á½¥¹ĞÍ•É•Ğğ)ğAA}UI1€ğQ•µÁ±…Ñ”ğÁÁ±¥…Ñ¥½¸½É¥¥¸ì±½…°‘•™…Õ±Ğ¥ÌÁ½ÉĞ€ÌÀÀÀğ)ğ5=}5=€ğ•µ¼½¹±äğ¹…‰±•Ì‘•Ñ•Éµ¥¹¥ÍÑ¥ŒÁÉ½Ù¥‘•È°Í••°…¹‘•µ¼…½Õ¹ÑÌğ)ğ9aQ}AU	1%}5=}5=€ğ•µ¼U$ğáÁ½Í•Ì‘•µ¼µµ½‘”ÁÉ•Í•¹Ñ…Ñ¥½¸ÍÑ…Ñ”ğ)ğ5=}AMM]=I€ğM••ğA…ÍÍİ½É…ÍÍ¥¹•Ñ¼™¥Ñ¥½¹…°‘•µ¼…½Õ¹ÑÌğ)ğ=A9%}A%}-e€ğ=ÁÑ¥½¹…°ğ¹Ù¥É½¹µ•¹Ğ™…±±‰…¬™½È=Á•¹$½¹¹•Ñ¥½¸ğ)ğ9Q!I=A%}A%}-e€ğ=ÁÑ¥½¹…°ğ¹Ù¥É½¹µ•¹Ğ™…±±‰…¬™½È¹Ñ¡É½Á¥Œ½¹¹•Ñ¥½¸ğ)ğ5%9%}A%}-e€ğ=ÁÑ¥½¹…°ğ¹Ù¥É½¹µ•¹Ğ™…±±‰…¬™½È•µ¥¹¤½¹¹•Ñ¥½¸ğ)ğ=A9I=UQI}A%}-e€ğ=ÁÑ¥½¹…°ğ¹Ù¥É½¹µ•¹Ğ™…±±‰…¬™½È=Á•¹I½ÕÑ•È½¹¹•Ñ¥½¸ğ)ğAM-}A%}-e€ğ=ÁÑ¥½¹…°ğ¹Ù¥É½¹µ•¹Ğ™…±±‰…¬™½È••ÁM••¬½¹¹•Ñ¥½¸ğ)ğ=115}	M}UI1€ğ=ÁÑ¥½¹…°ğM•±˜µ¡½ÍÑ•=±±…µ„•¹‘Á½¥¹Ğğ((ğ½‘•Ñ…¥±Ìø((ŒŒ•Í¥¸ÁÉ¥¹¥Á±•Ì((Ä¸€¨©5½‘•°Í•±•Ñ¥½¸¥ÌÁ½±¥ä°¹½Ğ…ÁÁ±¥…Ñ¥½¸±½¥Œ¸¨¨…±±•ÉÌ‘•ÍÉ¥‰”„İ½É­±½…ì½Á•É…Ñ½ÉÌ½İ¸Ñ¡”É½ÕÑ¥¹œ‘•¥Í¥½¸¸(È¸€¨©±¥¥‰¥±¥ÑäÁÉ••‘•Ì½ÁÑ¥µ¥é…Ñ¥½¸¸¨¨¸¥¹…Á…‰±”½ÈÁÉ½¡¥‰¥Ñ•…¹‘¥‘…Ñ”…¹¹½Ğİ¥¸‰äÍ½É¥¹œİ•±°•±Í•İ¡•É”¸(Ì¸€¨©Ù•Éä‘•¥Í¥½¸Í¡½Õ±‰”•áÁ±…¥¹…‰±”¸¨¨M•±•Ñ•°É•©•Ñ•°…¹±½İ•ÈµÉ…¹­•…¹‘¥‘…Ñ•Ì…±°±•…Ù”•Ù¥‘•¹”¸(Ğ¸€¨©…¥±ÕÉ”¥Ì±…ÍÍ¥™¥•‰•™½É”É•…Ñ¥½¸¸¨¨I•ÑÉä…¹™…±±‰…¬‘•Á•¹½¸Í•µ…¹Ñ¥Ì°¹½Ğ„‰±…¹­•Ğ±½½À¸(Ô¸€¨©I•½Ù•Éä¥Ì‰½Õ¹‘•¸¨¨ÑÑ•µÁĞ½Õ¹Ğ°Á•Èµ…ÑÑ•µÁĞÑ¥µ•½ÕĞ°Ñ½Ñ…°Ñ¥µ•½ÕĞ°…¹…¹•±±…Ñ¥½¸…±°Ñ•Éµ¥¹…Ñ”İ½É¬¸(Ø¸€¨©…±±‰…¬‘½•Ì¹½Ğ‰åÁ…ÍÌÍ…™•Ñä‘•¥Í¥½¹Ì¸¨¨MQe}IUM1€ÍÑ½ÁÌ‰ä‘•™…Õ±Ğ¸(Ü¸€¨©Q•¹…¹ĞÍ½Á”½µ•Ì™É½´…ÕÑ¡•¹Ñ¥…Ñ•½¹Ñ•áĞ¸¨¨A…å±½…™¥•±‘Ì…¹¹½ĞÍ•±•Ğ…¹½Ñ¡•Èİ½É­ÍÁ…”¸(à¸€¨©AÉ½Ù¥‘•È‘¥™™•É•¹•ÌÍÑ½À…Ğ…‘…ÁÑ•È‰½Õ¹‘…É¥•Ì¸¨¨I½ÕÑ¥¹œ°ÑÉ…¥¹œ°½ÍĞ°…¹…¹…±åÑ¥Ì½¹ÍÕµ”¹½Éµ…±¥é•½¹ÑÉ…ÑÌ¸(ä¸€¨©•µ½¹ÍÑÉ…Ñ¥½¸…¹A$Í¡…É”Ñ¡”…Ñ•İ…ä¸¨¨I•ÁÉ½‘Õ¥‰¥±¥Ñä½µ•Ì™É½´Ñ¡”ÁÉ½Ù¥‘•È°¹½Ğ„Á…É…±±•°…ÁÁ±¥…Ñ¥½¸Á…Ñ ¸(ÄÀ¸€¨©=Á•É…Ñ¥½¹…°•Ù•¹ÑÌ‰•½µ”ÅÕ•Éå…‰±”É•½É‘Ì¸¨¨áÁ±…¹…Ñ¥½¹Ì…¹…ÑÑ•µÁÑÌÍÕÉÙ¥Ù”‰•å½¹ÑÉ…¹Í¥•¹Ğ±½Ì¸((ŒŒ½Õµ•¹Ñ…Ñ¥½¸()ğ½Õµ•¹ĞğAÕÉÁ½Í”ğ)ğ€´´´ğ€´´´ğ)ğmÉ¡¥Ñ•ÑÕÉ•t¡‘½Ì½I!%QQUI¹µ¤ğMåÍÑ•´Ñ½Á½±½ä°±¥™•å±”°™…±±‰…¬°‘…Ñ„°Í•ÕÉ¥Ñä°‘•Á±½åµ•¹Ğğ)ğmA$I•™•É•¹•t¡‘½Ì½A%}II9¹µ¤ğI•ÅÕ•ÍĞ½É•ÍÁ½¹Í”½¹ÑÉ…Ğ°¡•…‘•ÉÌ°¥‘•µÁ½Ñ•¹ä°…¹•ÉÉ½ÉÌğ)ğmI½ÕÑ¥¹œ¹¥¹•t¡‘½Ì½I=UQ%9}9%9¹µ¤ğ±¥¥‰¥±¥Ñä°•¥¡Ğ½É‘•É¥¹œÍÑÉ…Ñ•¥•Ì°…¹Í½É¥¹œÍ•µ…¹Ñ¥Ìğ)ğm…±±‰…¬¹¥¹•t¡‘½Ì½11	-}9%9¹µ¤ğ…¥±ÕÉ”Ñ…á½¹½µä°‰½Õ¹‘••á•ÕÑ½È°‰…­½™˜°…¹Í…™•Ñä‰•¡…Ù¥½Èğ)ğmAÉ½Ù¥‘•È‘…ÁÑ•ÉÍt¡‘½Ì½AI=Y%I}AQIL¹µ¤ğ‘…ÁÑ•È¥¹Ñ•É™…”…¹Í•Ù•¸É•¥ÍÑ•É•ÁÉ½Ù¥‘•ÉÌğ)ğm…Ñ…‰…Í”•Í¥¹t¡‘½Ì½Q	M}M%8¹µ¤ğI•±…Ñ¥½¹…°½İ¹•ÉÍ¡¥À°¥¹‘•á•Ì°)M=9‰½Õ¹‘…É¥•Ì°…¹…É•…Ñ•Ìğ)ğmM•ÕÉ¥Ñä5½‘•±t¡‘½Ì½MUI%Qe}5=0¹µ¤ğÕÑ¡•¹Ñ¥…Ñ¥½¸°•¹ÉåÁÑ¥½¸°¥Í½±…Ñ¥½¸°…ÕÑ¡½É¥é…Ñ¥½¸°…¹É•‘…Ñ¥½¸ğ)ğmQ¡É•…Ğ5½‘•±t¡‘½Ì½Q!IQ}5=0¹µ¤ğÍÍ•ÑÌ°…‘Ù•ÉÍ…É¥•Ì°µ¥Ñ¥…Ñ¥½¹Ì°…¹…•ÁÑ•É¥Í¬ğ)ğmAÉ¥Ù…ä5½‘•±t¡‘½Ì½AI%Ye}5=0¹µ¤ğ5•Ñ…‘…Ñ„É•Ñ•¹Ñ¥½¸°Í•É•ĞÍÑ½É…”°…¹‘•±•Ñ¥½¸‰•¡…Ù¥½Èğ)ğm•¥Í¥½¹Ít¡‘½Ì½%M%=9L¹µ¤ğÉ¡¥Ñ•ÑÕÉ…°¡½¥•Ì…¹Ñ¡•¥ÈÑÉ…‘”µ½™™Ìğ)ğmQ•ÍĞA±…¹t¡‘½Ì½QMQ}A18¹µ¤ğMÕ¥Ñ”‰½Õ¹‘…É¥•Ì…¹¡¥ µÙ…±Õ”¥¹Ù…É¥…¹ÑÌğ)ğm•Á±½åµ•¹Ñt¡‘½Ì½A1=e59P¹µ¤ğY•É•°°MÕÁ…‰…Í”°µ¥É…Ñ¥½¹Ì°Í••°…¹½Á•É…Ñ¥¹œ¡•­Ìğ((ŒŒ1¥•¹Í”…¹…ÕÑ¡½È()m5%Qt¡1%9M¤ƒ
Ü	Õ¥±Ğ‰ä€¨©ÉÍ±…¸YÕéµ…°1½¹”¨¨