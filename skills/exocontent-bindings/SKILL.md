---
name: exo-content-bindings
description: Use when the user wants to create Data Assemblies (content bindings) in a Contentful Experience Orchestration space. Triggers on "content binding", "data assembly", "wire up content", "bind entries to components", "create DA", "hydrate component", or when a space has component types with content properties that need content from existing entries. Also use when reasoning about whether a property is a content property or a design property, whether a property is public or should be hoisted, or whether a reference is a slot or a content binding.
---

# ExO Content Bindings — Data Assembly Creator

## Overview

Creates Data Assemblies that connect existing Contentful entries to Experience Orchestration component types. A Data Assembly is a parametrized query with a known return type — it describes *how* entry fields hydrate a component's content properties.

**Mental model — four layers:**

| Layer | Entity | What it does | Example |
|-------|--------|--------------|---------|
| Schema | Component Type / Template | Declares `contentProperties` — named "holes" expecting content | `heading`, `image`, `ctaLabel` |
| Recipe | Data Assembly (API) / Binding Set (UI) | Describes *how* entries fill those holes (resolvers + return map) | "Product Card from Product" |
| Instance | Experience / Fragment / Inline Component | Stores `contentBindings` — a chosen DA + parameter entries | this card uses `productEntry123` |
| Runtime | Delivery payload | Resolved values written into content properties | `heading = "Spring Sale"` |

This skill operates at the **Recipe layer** — creating and publishing Data Assemblies.

**The invariant that makes the model work:** the component tree **always reads through `$contentProperties/...`** — never directly from an entry, never from `$contentBindings/...`. Every binding strategy exists to fill a content property. *A binding that fills no content property computes data nothing reads.* Use this as a correctness check on any DA you design: trace each `return` key to a declared content property, or delete it.

The practical consequence: from the component's point of view, a manual value and a DA-hydrated value are indistinguishable. It just reads a content property. That is why the DA-vs-literal choice (below) is a modeling decision, not a rendering one.

## Terminology

Precise language prevents misunderstandings between these easily conflated concepts:

| Term | What it is | What it is NOT |
|------|-----------|----------------|
| **Content property** | A named input on a Component Type or Template that receives content | Not a content-type field (those are the *source*) |
| **Content-type field** | A field on a Contentful content type (the CMS data) | Not a content property (those are on ExO components) |
| **Parameter** | One marketer selection input on a DA, constrained to allowed content types | Not a binding — it's the *input* to a binding |
| **Field mapping** | A target content property + source path starting from a parameter | Not the parameter itself |
| **Binding set** | The UI/editor name for an editable data-wiring configuration that corresponds 1:1 with a Data Assembly. Use "Binding Set" when referencing editor UI; use "Data Assembly" when referencing API calls. | Not the DA entity itself — same thing, different contexts |
| **Prebinding** | The internal/engineering name for the ComponentType editor workflow where DAs are defined. This skill automates what Prebinding does in the UI. | Not the runtime resolution step |
| **Content binding** | An instance choosing a DA + providing entry IDs for its parameters (at the Experience/Fragment level) | Not the DA itself (that's the recipe) |
| **Nested binding** | A PropertyMapping that gives a content property the whole output of a child DA through a DataAssemblyResolver | Not a reference field traversal |
| **Reference path** | Zero or more reference fields followed by a terminal value field | Not a display label |
| **Template** | A page-level entity governing Experiences (has channel config). Can be coded or composite, same as component types | Not interchangeable with "component type" — templates have channels/viewports |

## Content property vs. design property

A content property is content, not presentation. Before designing any mapping, apply this test to each property:

- Changing the value changes **what is said** → **content property** (bindable; a DA may fill it)
- Changing the value changes **how it looks** → **design property** (never bind it)

**Apply the test explicitly rather than guessing from the property name, and rather than relying on which array the property appears in.** `variant`, `columns`, `backgroundColor`, `showDivider`, `theme`, `alignment` are design properties **even when their values happen to come from the CMS**. A `theme: light|dark` field on a content type is the classic trap: it is CMS-authored, so it looks bindable, but it changes how the component looks, so it is not a content property and must not appear in a DA's `return` map.

The converse also holds: a property whose name sounds decorative (`badgeText`, `eyebrow`, `label`) is a content property if changing it changes what the page says.

This test governs step 5.3. A source field that fails it is not an unmapped content property — it is *correctly* unmapped, and should be reported that way in the Binding Plan rather than listed as a gap.

## Inputs

| Input | Source | Required | Default |
|-------|--------|----------|---------|
| Space ID | User provides or detect from context | Yes | — |
| Environment ID | User provides | No | `master` |
| CMA token | User provides or `$CMA_TOKEN` env var | Yes | — |
| API host | Domain for CMA requests | No | `api.contentful.com` (`api.flinkly.com` for staging) |

## Process

### 1. Introspect the space

Fetch all component types and content types.

```bash
# Fetch component types
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/component_types"
```

```bash
# Fetch content types (source data)
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/content_types"
```

### 1.5 Check for a reference space (STRONGLY RECOMMENDED)

Ask: **"Is there a reference space with the same components already wired with DAs? If yes, provide its space ID."**

If a reference exists, fetch its DAs FIRST and replicate their patterns exactly. This eliminates guesswork around query style, pointer syntax, RichText handling, and parameter naming.

```bash
# Fetch DAs from reference space
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$REF_API_HOST/spaces/$REF_SPACE_ID/environments/$REF_ENVIRONMENT_ID/data_assemblies" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for da in data.get('items', []):
    print(f\"\n== {da['name']} (id: {da['sys']['id']}) ==\")
    print(f\"  dataType: {json.dumps(da['sys'].get('dataType', []), indent=2)}\")
    print(f\"  parameters: {json.dumps(da.get('parameters', {}), indent=2)}\")
    print(f\"  resolvers: {json.dumps(da.get('resolvers', {}), indent=2)}\")
    print(f\"  return: {json.dumps(da.get('return', {}), indent=2)}\")"
```

**What to extract from the reference:**
- Query style: `_node` vs. direct (`contentType(id: $id)`)
- Pointer syntax: `$from` vs. bare string pointers
- RichText pattern: `{ document: json }` alias + bare parent pointer
- Parameter naming: typically `{contentTypeId}Id`
- Whether `kind` is used in resolvers
- DA reuse: same DA linked to multiple component types?

If no reference space exists, proceed — but flag higher risk of style drift in the binding plan.

### 2. Classify component types: coded vs. composite

This is the primary decision fork. Every component type falls into one of two categories, and the DA design approach differs fundamentally.

#### Classification rules

| Signal | Classification |
|--------|---------------|
| No `componentTree` or empty `componentTree` | **Coded** |
| `Contentful:CodedImplementation` annotation | **Coded** |
| Has `componentTree` with children | **Composite** |
| `Contentful:ComposedImplementation` annotation | **Composite** |

```bash
# Classify all component types
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/component_types" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
coded, composite = [], []
for ct in data.get('items', []):
    tree = ct.get('componentTree', {})
    has_children = bool(tree.get('children', []))
    cps = ct.get('contentProperties', [])
    slots = ct.get('slots', [])
    entry = {
        'id': ct['sys']['id'],
        'name': ct['name'],
        'contentProps': len(cps),
        'slots': len(slots)
    }
    if has_children:
        composite.append(entry)
    else:
        coded.append(entry)

print('=== CODED (leaf components — straightforward DA design) ===')
for c in coded:
    print(f\"  {c['name']} (id: {c['id']}) — {c['contentProps']} content props, {c['slots']} slots\")

print(f\"\n=== COMPOSITE (tree components — check hoisting + slots) ===\")
for c in composite:
    print(f\"  {c['name']} (id: {c['id']}) — {c['contentProps']} content props, {c['slots']} slots\")"
```

#### What the classification means for DA design

| | Coded | Composite |
|---|---|---|
| **Content properties** | All direct and public | Mix of direct + hoisted from children |
| **Hoisting** | N/A — no children | Must identify which props are hoisted vs. direct |
| **Slots** | May have slots (rare) | Usually has slots |
| **DA complexity** | Simple: one resolver maps fields → props | Moderate: must respect hoisting + slot boundaries |
| **May not need a DA** | Unlikely (it has content props for a reason) | Possible — if ALL content comes via slot children |

### 3. Design DAs for CODED component types

Coded components are straightforward. All `contentProperties` are public and directly bindable.

**Steps:**
1. List the component's `contentProperties` (all are public)
2. Find a content type whose fields match those properties (by name/type)
3. Design a single entity or collection resolver
4. Map resolver output → content properties via return expressions

```bash
# Inspect a coded component's content properties
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/component_types/$CT_ID" \
  | python3 -c "
import sys, json
ct = json.load(sys.stdin)
print(f\"== {ct['name']} (CODED) ==\")
print(f\"\\nContent properties (ALL public, ALL bindable):\")
for cp in ct.get('contentProperties', []):
    req = '✓ required' if cp.get('required') else '○ optional'
    print(f\"  {cp['id']}: {cp['type']} ({req})\")
slots = ct.get('slots', [])
if slots:
    print(f\"\\nSlots (children need their own DAs):\")
    for s in slots:
        print(f\"  {s['id']}: {s.get('name', '')}\")"
```

### 4. Design DAs for COMPOSITE component types

Composites require more analysis. Their `contentProperties` array contains a mix of:
- **Direct properties** — declared on the composite itself
- **Hoisted properties** — bubbled up from children in the `componentTree`

Both are public and bindable, but you need to understand the origin to design the GraphQL query correctly.

#### Does this composite need a DA at all?

| Situation | Needs DA? |
|-----------|-----------|
| Has `contentProperties` that should be filled from entries | **Yes** |
| All content comes from slot children (each with their own DA) | **No** — skip |
| Only has `designProperties` (no content props) | **No** — skip |
| Has `contentProperties` but all are manually filled (literals) | **No** — use manual values |

```bash
# Inspect a composite component — content properties + tree
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/component_types/$CT_ID" \
  | python3 -c "
import sys, json
ct = json.load(sys.stdin)
print(f\"== {ct['name']} (COMPOSITE) ==\")

cps = ct.get('contentProperties', [])
print(f\"\\nPublic content properties ({len(cps)} total — all bindable):\")
for cp in cps:
    req = '✓ required' if cp.get('required') else '○ optional'
    print(f\"  {cp['id']}: {cp['type']} ({req})\")

tree = ct.get('componentTree', {})
children = tree.get('children', [])
print(f\"\\nComponent tree ({len(children)} children):\")
for node in children:
    props = node.get('props', {})
    bindings = []
    for key, val in props.items():
        if isinstance(val, str) and '\$contentProperties/' in val:
            bindings.append(f\"{key} ← {val}\")
    ct_ref = node.get('type', node.get('componentType', '?'))
    if bindings:
        print(f\"  {ct_ref}: {', '.join(bindings)}\")
    else:
        print(f\"  {ct_ref}: (no content property bindings)\")

slots = ct.get('slots', [])
if slots:
    print(f\"\\nSlots ({len(slots)} — children here get their OWN DAs):\")
    for s in slots:
        allowed = s.get('allowedTypes', 'any')
        print(f\"  {s['id']}: allows {allowed}\")"
```

#### Understanding hoisted properties

In a composite's `componentTree`, child nodes reference the parent's public properties via `$contentProperties/<id>`. This tells you:
- Which content property feeds which child
- That the property IS public (it's in the parent's `contentProperties` array)
- The child reads it at render time — the DA fills it at bind time

**Key insight:** From the DA's perspective, hoisted vs. direct doesn't matter for construction. Both appear in `contentProperties` and both are targeted the same way in the `return` mapping. The distinction matters for *understanding* (what renders where) but not for *DA creation*.

#### Public vs. private

Not every content property in a composite is reachable from outside.

**Public** properties are the subset exposed on the component's surface. Only public properties can be overridden by a parent embedding this component, targeted by a Data Assembly, or seen and edited by a marketer. They are the component's **stable content input contract**.

**Private** properties belong to child components inside the `componentTree` and are not exposed. There is no `privateProperties` array — privacy is defined *by absence*: a child property is private precisely because it was **not hoisted**. Do not go looking for a list of private properties; enumerate the tree's children and subtract what appears in the parent's `contentProperties`.

**The golden rule: never bind, override, or map a property that is not public.** If something must be bound, it has to be hoisted first — which is a component-type change, outside this skill's scope.

#### Hoisting rules

1. **Required** child content properties are **automatically hoisted** to the parent's public surface
2. **Optional** child properties are hoisted **intentionally** — only when the designer decides the parent should control them
3. If a needed property isn't in the parent's `contentProperties`, it's private — the component type must be updated first (out of scope)
4. Per-property hoisting and whole-component hoisting (`TypeRef`) are mutually exclusive for the same child
5. **De-hoisting orphans DAs** — if a public property is later un-exposed, every DA referencing it breaks. This is why step 5.1 checks existing DAs before you add another.

**Rules 1 and 3 can contradict each other — say so when they do.** If a child property is **required** on the child but **absent** from the parent's `contentProperties`, rule 1 says it should have been hoisted automatically. Do not silently record it as "intentionally private." Report it as a **possible modeling or auto-hoisting defect** for the component-type owner, alongside the blocked mapping. A required-but-unreachable property means the composite cannot render correctly from any binding.

#### Should a property be public?

You cannot change hoisting from this skill, but you will be asked *whether* something should be hoisted. Recommend hoisting when **any** of these hold:

- it is **required** by the child (automatic — see the contradiction rule above),
- a **marketer must control it** per instance,
- a **DA needs to fill it** — only public properties are bindable,
- a **parent must override it** when embedding the child.

Recommend keeping it private when:

- it is an internal implementation detail (a computed alt text, a layout-only string),
- exposing it adds noise without editorial value — hoisting every child property produces `text1, text2, url1, url2…` clutter, which is explicitly discouraged,
- nothing outside the child will ever bind to or override it.

**Default posture: hoist the minimum that satisfies the four triggers; leave everything else private.** A small, intentional public surface is the goal.

#### Slot boundaries

Slots create a hard DA ownership boundary:

```
Parent DA scope:
├── parent's contentProperties (direct + hoisted) ← DA targets these
├── componentTree children read via $contentProperties/... ← fed by parent DA
└── [SLOT: "main"]
    └── Child components placed here ← SEPARATE DAs, not parent's
```

**Never** attempt to map fields into a slot child's properties from the parent's DA.

#### Slot vs. content binding — the distinction that decides scope

Both are reference-shaped. They mean opposite things, and confusing them produces a structurally wrong experience.

| | Slot | Content binding |
|---|---|---|
| Means | "this component **contains** these other visual components" | "this component **reads data from** these records" |
| Referenced thing | becomes a Fragment inside this component | stays content, accessed through a Data Assembly |
| Target shape | presentational — has its own layout, design properties, nested references | data-oriented — flat domain data, no layout |

**How to tell:** look at what the reference actually points to. If the target has its own visual structure (layout fields, design properties, nested presentational references), it is a slot. If it is flat domain data — categories, tags, profiles, events — referenced by many different types as a shared source, it is a binding.

The same distinction routes the request you were given. "Fill the slots" is ambiguous and resolves by context:

- **Assembly** — placing fragments/components into a template's structural slots. Only when the user is actively building or changing a tree.
- **Content binding** — linking CMS entries to binding parameters on an **already-assembled** experience. The signal: the user is not asking to change layout, they want content connected to what already exists.

Phrases like "fill unlinked slots", "populate empty slots", "fill in missing entries" with **no structural intent** mean **content binding on instances**, not assembly — and not this skill either. This skill builds the *recipes*; it does not attach bindings to Experience or Fragment instances (see Limitations).

**So when a request contains that phrasing, name it rather than only declaring it out of scope.** Say which layer it belongs to, confirm that the DAs this skill creates are the prerequisite for it, and state what remains to be done afterwards — per instance, in the editor or via the instance API. Answering "out of scope" without naming the layer leaves the user unable to act.

**You MUST produce a complete binding plan and get user approval before creating any Data Assemblies.** Do not skip this step. Do not create DAs incrementally without a plan.

#### 5.1 Fetch existing DAs in this space

```bash
# Fetch existing data assemblies
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for da in data.get('items', []):
    returns = list(da.get('return', {}).keys())
    params = list(da.get('parameters', {}).keys())
    print(f\"  {da['name']} (id: {da['sys']['id']})\")
    print(f\"    params: {params}, returns: {returns}\")"
```

#### 5.2 Sample entries to verify field semantics

**Do not skip this step.** Field names are ambiguous — `topic` could be a category tag or a paragraph, `subline` could be a subtitle or body text. Fetch 1-2 sample entries per source content type to see what fields actually contain:

```bash
# Sample entries for a content type
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/entries?content_type=$CT_ID&limit=2" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for entry in data.get('items', []):
    print(f\"\\n== {entry['sys']['id']} ==\")
    for field_id, locales in entry.get('fields', {}).items():
        val = next(iter(locales.values()), None)
        if isinstance(val, str):
            preview = val[:80] + ('...' if len(val) > 80 else '')
            print(f\"  {field_id}: \\\"{preview}\\\"\")
        elif isinstance(val, dict) and val.get('sys', {}).get('type') == 'Link':
            print(f\"  {field_id}: → Link<{val['sys'].get('linkType', '?')}> {val['sys'].get('id', '')}\")
        elif isinstance(val, dict) and 'nodeType' in val:
            print(f\"  {field_id}: [RichText document]\")
        elif isinstance(val, list):
            print(f\"  {field_id}: [{len(val)} items]\")
        else:
            print(f\"  {field_id}: {json.dumps(val)[:60]}\")"
```

Use the actual field values to resolve ambiguities:
- A `Symbol` containing "AI & Automation" is a category tag, not a description
- A `Text` containing a full paragraph is body content, not a subtitle
- A `RichText` field contains structured JSON (nodeType, content arrays)

**Flag ambiguous mappings** — if multiple source fields could map to one target property, note the ambiguity in the plan and confirm with the user.

#### 5.3 Infer field mappings

**Gate first, then match.** For every candidate pair, in order:

1. **Is the target a content property at all?** Apply the content-vs-design test (see "Content property vs. design property"). A design property is never a mapping target, no matter how well the source field fits.
2. **Is the target public?** If it is not in the component type's `contentProperties`, stop — the golden rule applies. Record it as blocked-pending-hoisting, and check the required-but-unhoisted contradiction rule.
3. **Is the target on a slot child?** If so it belongs to that child's own DA, not this one.
4. Only then match types and semantics.

Match content type fields to component content properties using these heuristics:

| Content property type | Matching content type field | Resolver kind |
|-----------------------|----------------------------|---------------|
| `String` | `Symbol`, `Text` | `entity` |
| `RichText` | `RichText` or `String` (JSON) | `entity` (see RichText Handling section) |
| `Media` (url/width/height/alt) | `Link<Asset>` | `entity` |
| `Array` of `Record` | `Array<Link<Entry>>` (multi-ref) | `collection` |
| `Record` (structured) | `Link<Entry>` (single ref) | `entity` (nested DA or inline) |
| `TypeRef` (whole-component) | `Link<Entry>` | Nested DA |

**Naming conventions:**
- **DA IDs:** `{component-type-id}-{source-content-type-id}` (e.g., `hero-banner-page-hero`)
- **Parameter IDs:** `{contentTypeId}Id` (e.g., `capabilityId`, `testimonialId`) — appears in the marketer-facing binding panel
- **Parameter `name` field:** Human-readable label (e.g., `"name": "Capability"`) — always include this

**Choosing the source when several fields or content types could fill one target:**

1. **Type first.** The source field's type must be able to produce the target's declared type, and a parameter's `allowedTypes` must contain the content type. This is a hard filter, not a preference.
2. **Semantic fit second.** Judge the field's actual content — sampled values and the field name — against the property's intent. Field names are semantic signals, sampled values are evidence. Step 5.2 exists for this.
3. **Context third.** A field that fits the property but contradicts the component's subject is a poor choice even with a perfect type match.
4. **Honor stated constraints.** Focus areas, exclusions, and filters the user stated persist across the whole run, not just the message they appeared in. Carry them forward into every mapping decision.

**Confidence maps to action:** *high* = direct match, map it. *medium* = plausible, map it and mark it for review in the Binding Plan. *low* = weak. **Prefer leaving a property unmapped and naming it over mapping something low-confidence and wrong** — a wrong mapping is much harder for the user to notice than an absent one, because it produces plausible content in the right shape. Unmapped properties are a line item in the Binding Plan; wrong ones are a silent defect.

**Never claim to have removed, replaced, or rewired an existing binding.** Existing DAs found in step 5.1 are left alone unless the user explicitly asks for a change. If a component already has a DA covering the same properties, reuse or extend it (see "Reusing One DA Across Multiple Component Types") — do not create a competing one and do not describe the result as having replaced anything.

#### 5.4 Output the Binding Plan

Present the FULL plan as a single table covering every component type. This is the contract the user approves before execution begins.

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                           BINDING PLAN                                       ║
╠══════════════════════════════════════════════════════════════════════════════╣

1. HeroBanner (CODED)
   DA: hero-banner-page-hero [NEW]
   Source: pageHero | Parameter: hero
   ┌─────────────────┬────────────────────┬──────────┬──────────────┐
   │ Content Property │ Source Field       │ Type     │ Depth        │
   ├─────────────────┼────────────────────┼──────────┼──────────────┤
   │ title (req)     │ pageHero.headline  │ String   │ shallow      │
   │ subtitle        │ pageHero.subline   │ String   │ shallow      │
   │ image (req)     │ pageHero.bgImage   │ Record   │ shallow      │
   │ ctaLabel        │ pageHero.ctaText   │ String   │ shallow      │
   │ ctaUrl          │ pageHero.ctaLink   │ String   │ shallow      │
   └─────────────────┴────────────────────┴──────────┴──────────────┘

2. BookCard (CODED)
   DA: book-card-book [NEW]
   Source: book | Parameter: bookId
   ┌─────────────────┬────────────────────┬──────────┬──────────────┐
   │ Content Property │ Source Field       │ Type     │ Depth        │
   ├─────────────────┼────────────────────┼──────────┼──────────────┤
   │ title (req)     │ book.title         │ String   │ shallow      │
   │ authorName      │ book.author.name   │ String   │ 2 hops (deep)│
   └─────────────────┴────────────────────┴──────────┴──────────────┘

3. ProductSection (COMPOSITE)
   DA: product-section-data [NEW]
   Source: productSection | Parameter: section
   ┌─────────────────┬──────────────────────────┬──────────┬──────────────┐
   │ Content Property │ Source Field             │ Type     │ Depth        │
   ├─────────────────┼──────────────────────────┼──────────┼──────────────┤
   │ title (req)     │ productSection.headline  │ String   │ shallow      │
   │ internalName    │ productSection.internalNm│ String   │ shallow      │
   └─────────────────┴──────────────────────────┴──────────┴──────────────┘
   Slot "products" → child needs own DA (see #4)

4. ProductGrid (CODED — slot child of #3)
   DA: product-grid-catalog [NEW]
   Source: catalog | Parameter: catalog
   ┌─────────────────────────┬──────────────────────────┬──────────┬─────────┐
   │ Content Property         │ Source Field             │ Type     │ Depth   │
   ├─────────────────────────┼──────────────────────────┼──────────┼─────────┤
   │ trendingProducts (req)  │ catalog.productsCol.items│ Array    │ shallow │
   └─────────────────────────┴──────────────────────────┴──────────┴─────────┘

5. Divider (CODED)
   DA: none needed (no content properties)

╠══════════════════════════════════════════════════════════════════════════════╣
║ PLAN SUMMARY                                                                 ║
╠══════════════════════════════════════════════════════════════════════════════╣
  Component types with content properties: 4
  DAs to create: 4
  DAs already existing: 0
  Skipped (no content props): 1
  Deep bindings (>1 hop): 1 (book.author.name — 2 hops ✓)
  Nested DAs required: 0
╚══════════════════════════════════════════════════════════════════════════════╝
```

#### 5.5 Get approval

Ask: **"Here's the binding plan. Does this look correct? Any mappings to add, remove, change source content types, or rename DA IDs?"**

**Do NOT proceed to step 6 until the user explicitly approves the plan.**

If the user requests changes, update the plan and present it again. Only proceed once approved.

### 6. Create Data Assemblies

**PUT body structure:** The `sys` object in the request body MUST contain `id`, `type`, and `dataType`. Optionally include `version` for updates. All other `sys` fields (space, environment, createdBy, etc.) are server-managed.

```json
{
  "sys": {
    "id": "my-da-id",
    "type": "DataAssembly",
    "dataType": [...]
  },
  "metadata": { "tags": [] },
  "name": "...",
  "description": "...",
  "parameters": { ... },
  "resolvers": { ... },
  "return": { ... }
}
```

**Notes on optional fields:**
- `kind` (`"entity"` or `"collection"`) is accepted but not required. If replicating from a reference space that omits it, don't add it.
- `name` on parameters (e.g., `"name": "Capability"`) is the human-readable label shown in the binding panel. Always include it.

#### 6.1 Entity resolver (single entry → flat properties)

Used for: coded components, composites with direct/hoisted string properties.

```bash
curl -s -X PUT \
  -H "Authorization: Bearer $CMA_TOKEN" \
  -H "Content-Type: application/json" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
  -d '{
  "sys": {
    "id": "'$DA_ID'",
    "type": "DataAssembly",
    "dataType": [
      { "id": "title", "name": "Title", "type": "String", "required": false },
      { "id": "subtitle", "name": "Subtitle", "type": "String", "required": false }
    ]
  },
  "metadata": { "tags": [] },
  "name": "Hero Banner — Page Hero",
  "description": "Hydrates hero banner from a pageHero entry.",
  "parameters": {
    "pageHeroId": {
      "name": "Page Hero",
      "type": "ResourceLink",
      "linkType": "Contentful:Entry",
      "allowedResources": [{
        "type": "Contentful:Entry",
        "source": "crn:contentful:::content:spaces/$self/environments/$self",
        "allowedTypes": ["pageHero"]
      }]
    }
  },
  "resolvers": {
    "main": {
      "source": "Contentful:GraphQL",
      "query": "query ($id: ID!) { _node(id: $id) { __typename ... on PageHero { headline subline ctaText ctaLink } } }",
      "parameters": { "id": "$parameters/pageHeroId" }
    }
  },
  "return": {
    "title": {
      "$from": { "source": "$resolvers/main", "select": "_node/headline" }
    },
    "subtitle": {
      "$from": { "source": "$resolvers/main", "select": "_node/subline" }
    }
  }
}'
```

#### 6.2 Collection resolver (multi-reference → array of records)

Used for: coded components with `Array<Record>` content properties (e.g., grids, lists).

```bash
curl -s -X PUT \
  -H "Authorization: Bearer $CMA_TOKEN" \
  -H "Content-Type: application/json" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
  -d '{
  "sys": {
    "id": "'$DA_ID'",
    "type": "DataAssembly",
    "dataType": [
      {
        "id": "items",
        "name": "Items",
        "type": "Array",
        "required": false,
        "items": {
          "type": "Record",
          "fields": [
            { "id": "title", "name": "Title", "type": "String" },
            { "id": "price", "name": "Price", "type": "String" }
          ]
        }
      }
    ]
  },
  "metadata": { "tags": [] },
  "name": "Product Grid — Catalog",
  "description": "Hydrates product grid from a catalog entry products collection.",
  "parameters": {
    "catalogId": {
      "name": "Catalog",
      "type": "ResourceLink",
      "linkType": "Contentful:Entry",
      "allowedResources": [{
        "type": "Contentful:Entry",
        "source": "crn:contentful:::content:spaces/$self/environments/$self",
        "allowedTypes": ["catalog"]
      }]
    }
  },
  "resolvers": {
    "gridResolver": {
      "source": "Contentful:GraphQL",
      "kind": "collection",
      "query": "query ($id: ID!) { _node(id: $id) { __typename ... on Catalog { productsCollection { items { title price } } } } }",
      "parameters": { "id": "$parameters/catalogId" }
    }
  },
  "return": {
    "items": {
      "$from": {
        "source": "$resolvers/gridResolver",
        "select": {
          "$on": {
            "type": {
              "Catalog": {
                "$from": {
                  "source": "productsCollection/items",
                  "select": { "title": "title", "price": "price" }
                }
              }
            }
          }
        }
      }
    }
  }
}'
```

#### 6.3 Nested Data Assembly resolver

Used for: `TypeRef` (whole-component hoisting) or reusing an existing DA for a linked entry.

```bash
curl -s -X PUT \
  -H "Authorization: Bearer $CMA_TOKEN" \
  -H "Content-Type: application/json" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
  -d '{
  "sys": {
    "id": "'$DA_ID'",
    "type": "DataAssembly",
    "dataType": [
      { "id": "authorName", "name": "Author Name", "type": "String", "required": false }
    ]
  },
  "metadata": { "tags": [] },
  "name": "Article Card — With Author",
  "description": "Hydrates article card, delegating author resolution to the shared author DA.",
  "parameters": {
    "articleId": {
      "name": "Article",
      "type": "ResourceLink",
      "linkType": "Contentful:Entry",
      "allowedResources": [{
        "type": "Contentful:Entry",
        "source": "crn:contentful:::content:spaces/$self/environments/$self",
        "allowedTypes": ["article"]
      }]
    }
  },
  "resolvers": {
    "authorResolver": {
      "source": "Contentful:DataAssembly",
      "dataAssembly": {
        "sys": {
          "type": "ResourceLink",
          "linkType": "Contentful:DataAssembly",
          "urn": "crn:contentful:::experience:spaces/$self/environments/$self/dataAssemblies/author-default"
        }
      },
      "parameters": { "item": "$parameters/articleId" }
    }
  },
  "return": {
    "authorName": {
      "$from": { "source": "$resolvers/authorResolver", "select": "name" }
    }
  }
}'
```

#### 6.4 Asset (Media) fields

For `Link<Asset>` fields mapped to a structured Media content property:

**Model a standalone asset field as a structured `Record`, never a bare `String` URL** — so dimensions and alt text survive to delivery. A URL-only `String` renders blank in any consumer that needs intrinsic dimensions (e.g. `next/image`).

**Alt text comes from the asset's `description`, falling back to `title`.** The `description` field is where editors write alternative text; `title` is a filename-derived label and is frequently something like `hero-bg-final-v3`. Shipping `title` as alt text is an accessibility defect, not a cosmetic one.

GraphQL query fragment — always select **both**:
```graphql
query ($id: ID!) {
  _node(id: $id) {
    __typename
    ... on PageHero {
      backgroundImage {
        url
        width
        height
        description
        title
        contentType
      }
    }
  }
}
```

Return mapping:
```json
"image": {
  "$from": {
    "source": "$resolvers/heroResolver",
    "select": {
      "$on": {
        "type": {
          "PageHero": {
            "$object": {
              "url": { "$from": { "source": "backgroundImage/url" } },
              "width": { "$from": { "source": "backgroundImage/width" } },
              "height": { "$from": { "source": "backgroundImage/height" } },
              "alt": { "$from": { "source": "backgroundImage/description" } },
              "contentType": { "$from": { "source": "backgroundImage/contentType" } }
            }
          }
        }
      }
    }
  }
}
```

**Resolving the fallback.** The pointer language has no coalesce operator — `$from` cannot express "description, else title" in one expression, and neither can GraphQL. So resolve the fallback **at design time**, in step 5.2:

1. Sample the assets actually linked by the source content type's asset field.
2. If `description` is populated on all or most of them, map `alt` ← `description` (above). This is the default.
3. If `description` is empty across the sample, map `alt` ← `title` **and record that substitution explicitly in the Binding Plan**, flagged as an accessibility gap for the content team to fill in. Do not present it as equivalent.
4. Keep `description` and `title` both in the GraphQL selection either way — the query costs nothing extra and the second field is needed the moment the choice is revisited.

Per-asset fallback is not achievable in the DA. If the source assets are genuinely mixed, say so rather than picking silently: the correct fix is populating `description` on the assets, not a cleverer mapping.

**One exception to the `Record` shape:** an asset *inside a collection* `Array` stays a flat URL `String`, because a `Record` cannot nest inside a collection item yet. See the Collection resolver section.

`sys.dataType` for a Media field:
```json
{
  "id": "image",
  "name": "Image",
  "type": "Record",
  "required": false,
  "fields": [
    { "id": "url", "name": "URL", "type": "String" },
    { "id": "width", "name": "Width", "type": "Number" },
    { "id": "height", "name": "Height", "type": "Number" },
    { "id": "alt", "name": "Alt text", "type": "String" },
    { "id": "contentType", "name": "Content Type", "type": "String" }
  ]
}
```

#### 6.5 Deep binding (reference traversal)

**Deep binding** crosses one or more Entry reference fields before reaching the value. Use it when a content property needs data from a linked entry (e.g., `Book → Author → name`).

**Hop limit: ≤ 3 hops.** The root entry is hop 1; each subsequent Entry reference adds one hop.

```
Book entry → author → mentor → name
hop 1        hop 2    hop 3    scalar (OK — 3 hops)

Catalog → publisher → author → imprint → name
hop 1     hop 2       hop 3    hop 4 ✗   (REJECTED — 4 hops)
```

##### Pattern 1: Scalar deep bind (inline reference traversal)

Read a field on a linked entry by traversing the reference in the GraphQL query:

```bash
curl -s -X PUT \
  -H "Authorization: Bearer $CMA_TOKEN" \
  -H "Content-Type: application/json" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
  -d '{
  "sys": {
    "id": "'$DA_ID'",
    "type": "DataAssembly",
    "dataType": [
      { "id": "title", "name": "Title", "type": "String", "required": true },
      { "id": "authorName", "name": "Author Name", "type": "String", "required": false }
    ]
  },
  "metadata": { "tags": [] },
  "name": "Book Card — With Author",
  "description": "Hydrates book card including the linked author name (2 hops).",
  "parameters": {
    "bookId": {
      "name": "Book",
      "type": "ResourceLink",
      "linkType": "Contentful:Entry",
      "allowedResources": [{
        "type": "Contentful:Entry",
        "source": "crn:contentful:::content:spaces/$self/environments/$self",
        "allowedTypes": ["book"]
      }]
    }
  },
  "resolvers": {
    "item": {
      "source": "Contentful:GraphQL",
      "query": "query ($id: ID!) { _node(id: $id) { __typename ... on Book { title author { name } } } }",
      "parameters": { "id": "$parameters/bookId" }
    }
  },
  "return": {
    "title": { "$from": { "source": "$resolvers/item", "select": "_node/title" } },
    "authorName": { "$from": { "source": "$resolvers/item", "select": "_node/author/name" } }
  }
}'
```

The path `_node/author/name` traverses the `author` reference (hop 2) and reads `name` (scalar). The GraphQL query **must** select `author { name }` — validation only allows paths that match selected fields.

##### Pattern 2: TypeRef deep bind (nested DA for linked entry)

When the linked entry is complex enough to warrant its own DA, use a nested `Contentful:DataAssembly` resolver. Pass the linked entry's `sys.id` as the child's parameter:

```bash
curl -s -X PUT \
  -H "Authorization: Bearer $CMA_TOKEN" \
  -H "Content-Type: application/json" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
  -d '{
  "sys": {
    "id": "'$DA_ID'",
    "type": "DataAssembly",
    "dataType": [
      { "id": "title", "name": "Title", "type": "String", "required": true },
      { "id": "author", "name": "Author", "type": "TypeRef", "required": false }
    ]
  },
  "metadata": { "tags": [] },
  "name": "Book — With Author DA",
  "description": "Hydrates book fields + delegates author to child DA (2 hops).",
  "parameters": {
    "bookId": {
      "name": "Book",
      "type": "ResourceLink",
      "linkType": "Contentful:Entry",
      "allowedResources": [{
        "type": "Contentful:Entry",
        "source": "crn:contentful:::content:spaces/$self/environments/$self",
        "allowedTypes": ["book"]
      }]
    }
  },
  "resolvers": {
    "item": {
      "source": "Contentful:GraphQL",
      "query": "query ($id: ID!) { _node(id: $id) { __typename ... on Book { title author { sys { id } } } } }",
      "parameters": { "id": "$parameters/bookId" }
    },
    "authorResolver": {
      "source": "Contentful:DataAssembly",
      "dataAssembly": {
        "sys": {
          "type": "ResourceLink",
          "linkType": "Contentful:DataAssembly",
          "urn": "crn:contentful:::experience:spaces/$self/environments/$self/dataAssemblies/author-default"
        }
      },
      "parameters": { "item": "$resolvers/item/_node/author/sys/id" }
    }
  },
  "return": {
    "title": { "$from": { "source": "$resolvers/item", "select": "_node/title" } },
    "author": "$resolvers/authorResolver"
  }
}'
```

The child DA (`author-default`) receives the author entry ID and resolves it independently. The parent's `author` return field gets the child DA's full output.

##### When to use scalar vs. TypeRef deep binding

| Scenario | Use |
|----------|-----|
| Need 1-2 fields from the linked entry | Scalar (inline in GraphQL query) |
| Linked entry is used by multiple parent DAs | TypeRef (shared child DA, reusable) |
| Linked entry maps to its own component with content properties | TypeRef (child DA matches child component) |
| > 3 fields from the linked entry | TypeRef (keeps parent query clean) |

##### Polymorphic deep binding (`$on.type`)

When a parameter accepts multiple content types and you need a deep bind that differs per type:

```json
"return": {
  "displayLabel": {
    "$from": {
      "source": "$resolvers/item/_node",
      "select": {
        "$on": {
          "type": {
            "Book": "title",
            "Magazine": "editor/name"
          }
        }
      }
    }
  }
}
```

- `Book` branch: shallow (field on root — 1 hop)
- `Magazine` branch: deep (Magazine → Editor → name — 2 hops)

**Rules for `$on.type` with required fields:** every allowed content type MUST have a branch. For optional fields, partial branch coverage is allowed.

### 7. Link the DA to its Component Type

**This step is required.** After creating a DA, you must add it to the target component type's `dataAssemblies` array. Without this link, the DA won't appear in the editor's binding panel for that component.

```bash
# Fetch the component type's current state
CT_RESPONSE=$(curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/component_types/$CT_ID")

CT_VERSION=$(echo "$CT_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['sys']['version'])")

# Extract existing dataAssemblies links (may be empty array)
EXISTING_DAS=$(echo "$CT_RESPONSE" | python3 -c "
import sys, json
ct = json.load(sys.stdin)
das = ct.get('dataAssemblies', [])
print(json.dumps(das))")

# Add new DA link to the array
NEW_DA_LINK='{
  "sys": {
    "type": "ResourceLink",
    "linkType": "Contentful:DataAssembly",
    "urn": "crn:contentful:::experience:spaces/$self/environments/$self/dataAssemblies/'$DA_ID'"
  }
}'

UPDATED_DAS=$(echo "$EXISTING_DAS" | python3 -c "
import sys, json
existing = json.load(sys.stdin)
new_link = json.loads('$NEW_DA_LINK')
# Don't add if already linked
if not any(d.get('sys',{}).get('urn','').endswith('/$DA_ID') for d in existing):
    existing.append(new_link)
print(json.dumps(existing))")

# Update the component type
curl -s -X PUT \
  -H "Authorization: Bearer $CMA_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Contentful-Version: $CT_VERSION" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/component_types/$CT_ID" \
  -d "$(echo "$CT_RESPONSE" | python3 -c "
import sys, json
ct = json.load(sys.stdin)
ct['dataAssemblies'] = $UPDATED_DAS
# Remove sys for the PUT body (API rejects it in body)
del ct['sys']
print(json.dumps(ct))")"
```

**URN format for DA links:**
```
crn:contentful:::experience:spaces/$self/environments/$self/dataAssemblies/{da-id}
```

### 8. Publish the Data Assembly

```bash
# Fetch the current version
VERSION=$(curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['sys']['version'])")

# Publish
curl -s -X PUT \
  -H "Authorization: Bearer $CMA_TOKEN" \
  -H "X-Contentful-Version: $VERSION" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID/published"
```

### 9. Verify

```bash
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
  | python3 -c "
import sys, json
da = json.load(sys.stdin)
print(f\"✓ {da['name']} (v{da['sys']['version']}, published: {'publishedVersion' in da['sys']})\")
print(f\"  Parameters: {list(da.get('parameters', {}).keys())}\")
print(f\"  Resolvers: {list(da.get('resolvers', {}).keys())}\")
print(f\"  Returns: {list(da.get('return', {}).keys())}\")"
```

### 10. Validate against reference (if reference space exists)

If a reference space was identified in step 1.5, compare your created DAs against it before producing the final binding map:

```bash
# Compare created DAs against reference
curl -s -H "Authorization: Bearer $CMA_TOKEN" \
  "$REF_API_HOST/spaces/$REF_SPACE_ID/environments/$REF_ENVIRONMENT_ID/data_assemblies" \
  | python3 -c "
import sys, json
ref = json.load(sys.stdin)
for da in ref.get('items', []):
    print(f\"REF: {da['sys']['id']}\")
    dt = da['sys'].get('dataType', [])
    for d in dt:
        print(f\"  {d['id']}: {d['type']}\")
    ret = da.get('return', {})
    for k, v in ret.items():
        style = 'bare' if isinstance(v, str) else '\$from'
        print(f\"  return.{k}: {style}\")"
```

**Check for:**
- `dataType` alignment — especially `RichText` vs. `String` (most common drift)
- Return mapping style — bare pointers vs. `$from` (should be consistent)
- Field coverage — any fields the reference maps that you don't?
- DA reuse — any reference DAs linked to multiple component types that you duplicated?
- Missing DAs — any reference DAs not replicated?

If discrepancies are found, fix them before producing the binding map.

## Worked Example: Hero + Card from Promotion Entry

This example (from [contentful/experiences](https://github.com/contentful/experiences/tree/main/examples/scripts/fixture)) shows two coded components hydrated from the same content type.

### Source content type: `promotion`

```
Fields:
  title: Symbol (required)
  teaser: Text
  ctaLabel: Symbol
  ctaUrl: Symbol
  image: Link<Asset>
```

### Component Type: `hero-plain` (coded)

```
contentProperties:
  ✓ title: String (required)
  ○ ctaLabel: String
  ○ ctaUrl: String
  ○ image: String
```

### Data Assembly: `hero-from-promotion`

```json
{
  "sys": {
    "id": "hero-from-promotion",
    "type": "DataAssembly",
    "dataType": [
      { "id": "title", "name": "Title", "type": "String", "required": true },
      { "id": "ctaLabel", "name": "CTA label", "type": "String", "required": false },
      { "id": "ctaUrl", "name": "CTA URL", "type": "String", "required": false },
      { "id": "image", "name": "Image URL", "type": "String", "required": false }
    ]
  },
  "metadata": { "tags": [] },
  "name": "Hero from Promotion",
  "description": "Maps a promotion entry into the hero-plain ComponentType",
  "parameters": {
    "promotionId": {
      "name": "Promotion",
      "type": "ResourceLink",
      "linkType": "Contentful:Entry",
      "allowedResources": [{
        "type": "Contentful:Entry",
        "source": "crn:contentful:::content:spaces/$self/environments/$self",
        "allowedTypes": ["promotion"]
      }]
    }
  },
  "resolvers": {
    "main": {
      "source": "Contentful:GraphQL",
      "query": "query ($id: ID!) { _node(id: $id) { __typename ... on Promotion { title ctaLabel ctaUrl image { url } } } }",
      "parameters": { "id": "$parameters/promotionId" }
    }
  },
  "return": {
    "title": { "$from": { "source": "$resolvers/main", "select": "_node/title" } },
    "ctaLabel": { "$from": { "source": "$resolvers/main", "select": "_node/ctaLabel" } },
    "ctaUrl": { "$from": { "source": "$resolvers/main", "select": "_node/ctaUrl" } },
    "image": { "$from": { "source": "$resolvers/main", "select": "_node/image/url" } }
  }
}
```

### Component Type: `card` (coded)

```
contentProperties:
  ✓ title: String (required)
  ○ teaser: String
  ○ ctaLabel: String
  ○ ctaUrl: String
  ○ image: String
```

### Data Assembly: `card-from-promotion`

Same source content type, different set of mapped fields (adds `teaser`):

```json
{
  "sys": {
    "id": "card-from-promotion",
    "type": "DataAssembly",
    "dataType": [
      { "id": "title", "name": "Title", "type": "String", "required": true },
      { "id": "teaser", "name": "Teaser", "type": "String", "required": false },
      { "id": "ctaLabel", "name": "CTA label", "type": "String", "required": false },
      { "id": "ctaUrl", "name": "CTA URL", "type": "String", "required": false },
      { "id": "image", "name": "Image URL", "type": "String", "required": false }
    ]
  },
  "metadata": { "tags": [] },
  "name": "Card from Promotion",
  "description": "Maps a promotion entry into the card ComponentType",
  "parameters": {
    "promotionId": {
      "name": "Promotion",
      "type": "ResourceLink",
      "linkType": "Contentful:Entry",
      "allowedResources": [{
        "type": "Contentful:Entry",
        "source": "crn:contentful:::content:spaces/$self/environments/$self",
        "allowedTypes": ["promotion"]
      }]
    }
  },
  "resolvers": {
    "main": {
      "source": "Contentful:GraphQL",
      "query": "query ($id: ID!) { _node(id: $id) { __typename ... on Promotion { title teaser ctaLabel ctaUrl image { url } } } }",
      "parameters": { "id": "$parameters/promotionId" }
    }
  },
  "return": {
    "title": { "$from": { "source": "$resolvers/main", "select": "_node/title" } },
    "teaser": { "$from": { "source": "$resolvers/main", "select": "_node/teaser" } },
    "ctaLabel": { "$from": { "source": "$resolvers/main", "select": "_node/ctaLabel" } },
    "ctaUrl": { "$from": { "source": "$resolvers/main", "select": "_node/ctaUrl" } },
    "image": { "$from": { "source": "$resolvers/main", "select": "_node/image/url" } }
  }
}
```

### Linking DAs to Component Types

After creation, each DA is added to its target component type's `dataAssemblies` array:

```json
{
  "dataAssemblies": [
    {
      "sys": {
        "type": "ResourceLink",
        "linkType": "Contentful:DataAssembly",
        "urn": "crn:contentful:::experience:spaces/$self/environments/$self/dataAssemblies/hero-from-promotion"
      }
    }
  ]
}
```

### Content Binding on an Experience Node

When a marketer uses this DA in an experience, the node stores:

```json
{
  "id": "node:hero",
  "nodeType": "InlineFragment",
  "componentType": {
    "sys": {
      "type": "ResourceLink",
      "linkType": "Contentful:ComponentType",
      "urn": "crn:contentful:::experience:spaces/$self/environments/$self/componentTypes/hero-plain"
    }
  },
  "contentBindings": {
    "sys": {
      "type": "ResourceLink",
      "linkType": "Contentful:DataAssembly",
      "urn": "crn:contentful:::experience:spaces/$self/environments/$self/dataAssemblies/hero-from-promotion"
    },
    "parameters": {
      "promo": {
        "sys": {
          "type": "ResourceLink",
          "linkType": "Contentful:Entry",
          "urn": "crn:contentful:::content:spaces/$self/environments/$self/entries/abc123"
        }
      }
    }
  }
}
```

At runtime, ExO executes the DA's GraphQL resolver with entry `abc123`, maps the result through the return expressions, and writes the resolved values into the component's content properties.

### Key Patterns from This Example

1. **`sys.dataType` mirrors `contentProperties`** — the DA's dataType IDs must match the component's content property IDs exactly
2. **One content type can feed multiple DAs** — `promotion` feeds both `hero-from-promotion` and `card-from-promotion`
3. **One component type can have multiple DAs (binding sets)** — different source content types produce different DAs for the same component; the marketer chooses which DA to use per instance
4. **Asset fields traversed with path notation** — `image { url }` in GraphQL, `_node/image/url` in the return select
5. **URN format is consistent** — `crn:contentful:::experience:spaces/$self/environments/$self/dataAssemblies/{id}`

### Binding Sets: Multiple DAs Per Component

A component type's `dataAssemblies` array can hold multiple DAs — each is an alternative **binding set**. The marketer picks one when configuring an instance:

```json
{
  "dataAssemblies": [
    { "sys": { "type": "ResourceLink", "linkType": "Contentful:DataAssembly", "urn": "...dataAssemblies/card-from-promotion" } },
    { "sys": { "type": "ResourceLink", "linkType": "Contentful:DataAssembly", "urn": "...dataAssemblies/card-from-blog-post" } },
    { "sys": { "type": "ResourceLink", "linkType": "Contentful:DataAssembly", "urn": "...dataAssemblies/card-from-product" } }
  ]
}
```

Each DA is a complete binding set (parameters + resolvers + return). They are **not** composed together — the marketer selects ONE per instance. Design multiple DAs when:
- The same component can be hydrated from different content types
- Different content types expose different subsets of fields
- You want to offer the marketer a choice of "what feeds this component"

### Reusing One DA Across Multiple Component Types

If two or more component types have the **same content property IDs** and you want the same source → target mapping, create ONE DA and link it to both component types in Step 7. Don't duplicate.

Example: `hero` and `mediaTextRow` both have `eyebrow`, `title`, `description`, `imageSrc` — a single `capability-da` linked to both is correct.

**When to reuse vs. duplicate:**
| Situation | Action |
|-----------|--------|
| Same content property IDs, same source content type | Reuse — link one DA to multiple component types |
| Same source content type, different property IDs | Create separate DAs (different return mappings) |
| Same property IDs but different source content types | Create separate DAs (different parameters) |

## Pointer Expression Reference

All `return` mappings and resolver `parameters` use pointer expressions. **Default to `$from` syntax** — it's the only form the BindingPanel editor can round-trip.

| Form | Use when | Example |
|------|----------|---------|
| `$from` | Reading a value from a resolver or parameter | `{ "$from": { "source": "$resolvers/r1", "select": "_node/title" } }` |
| `$on` | Branching on `__typename` (polymorphic) | `{ "$on": { "type": { "Article": "headline", "Page": "title" } } }` |
| `$literal` | Fixed value, no resolver needed | `{ "$literal": "Read more" }` |
| `$object` | Building a structured record explicitly | `{ "$object": { "url": "...", "alt": "..." } }` |

**`$from` vs. bare pointers:**
- **`$from` (default):** Use for all non-RichText fields. Required if the DA will be editable in the BindingPanel UI.
- **Bare pointers** (e.g., `"$resolvers/main/capability/headline"`): Valid and used by some reference implementations. They work for API-created DAs that won't be edited via the BindingPanel. If a reference space uses bare pointers, you can replicate that style.
- **RichText exception:** RichText fields MUST use bare pointers. `$from` is incompatible with `RichText` dataType — the platform needs a pointer to the parent object to recognize the type. See RichText Handling section.

## GraphQL Query Conventions

- **Two query styles** — both are valid:
  - `_node(id: $id)` — generic, works for any content type. Requires a `... on TypeName` fragment.
  - `contentTypeName(id: $id)` — direct, returns the typed object immediately. Simpler queries, no fragment needed.
  
  Example (direct style):
  ```graphql
  query ($id: String!) { capability(id: $id) { headline body { json } } }
  ```
  
  Example (`_node` style):
  ```graphql
  query ($id: ID!) { _node(id: $id) { __typename ... on Capability { headline body { json } } } }
  ```
  
  If a reference space uses direct queries, replicate that style. Otherwise default to `_node` — it's more portable across content types.

- **Root alias convention:** You can alias the root query (e.g., `entry: capability(id: $id)`) but it's not required. Trade-offs:
  - **No alias** (e.g., `capability(id: $id)`): return paths include the content type name (`$resolvers/main/capability/headline`) — self-documenting. This is what Contentful's tooling generates.
  - **With alias** (e.g., `entry: capability(id: $id)`): shorter paths (`$resolvers/r1/entry/headline`) but less informative.
  
  Recommend: match the reference space. If none, use no alias.

- Always include `__typename` in the query when using `_node` (required for `$on` branching)
- For collections: query the `...Collection { items { ... } }` pattern
- Field names in GraphQL are **camelCase versions** of the content type field IDs
- Asset fields expose: `url`, `width`, `height`, `description`, `title`, `contentType`. **Alt text comes from `description`, falling back to `title`** — select both, see § 6.4
- Reference fields require their own fragment: `... on ReferencedType { fields... }`
- **RichText fields** — see dedicated RichText Handling section below

## RichText Handling

**RichText is the ONE exception to "default to `$from`."** The platform requires a bare string pointer to the parent object (not the `/json` leaf) to recognize and resolve the RichText type. Using `$from` for RichText fields causes type validation errors.

### Correct pattern: `RichText` dataType + `{ document: json }` alias + bare pointer

```json
// sys.dataType entry
{ "id": "description", "name": "Description", "type": "RichText", "required": false }
```

```graphql
// GraphQL query — MUST alias json to "document"
query ($id: String!) {
  capability(id: $id) {
    subline { document: json }
  }
}
```

```json
// Return mapping — MUST be bare pointer to PARENT object (not /json, not /document)
"description": "$resolvers/main/capability/subline"
```

**Why this works:** The platform sees the parent object (which has a `document` key from the alias), recognizes it as RichText, and resolves it natively. The component receives a parsed RichText document object.

**What breaks:**
- `$from` + select to `/json` → API rejects: "expected RichText, got String"
- Bare pointer to `/json` leaf → platform can't recognize the RichText structure
- Missing `document: json` alias → platform can't find the document key

### Fallback: `String` dataType (when component expects raw JSON)

If the component's content property is typed as `String` (not `RichText`), deliver the raw JSON:

```json
// sys.dataType entry
{ "id": "body", "name": "Body", "type": "String", "required": false }
```

```json
// Return — $from is fine here because dataType is String
"body": { "$from": { "source": "$resolvers/r1", "select": "capability/body/json" } }
```

The component receives a JSON string and must parse it.

### Which to use

| Signal | Use |
|--------|-----|
| Content property type is `RichText` | **Bare pointer** pattern (alias + parent pointer) |
| Reference space uses `RichText` dataType | **Bare pointer** pattern |
| Content property type is `String` | `$from` + select to `/json` leaf |
| Legacy components expecting raw JSON strings | `$from` + String dataType |

## Type Mapping Reference

| Content type field | DA dataType | Notes |
|-------------------|-------------|-------|
| `Symbol` | `String` | Short text |
| `Text` | `String` | Long text (may contain markdown) |
| `Integer` | `Number` | — |
| `Number` | `Number` | — |
| `Boolean` | `Boolean` | — |
| `Date` | `String` | ISO 8601 string |
| `Location` | `Record` (lat/lon) | Rare in ExO |
| `RichText` | `RichText` (primary) or `String` (fallback) | See RichText Handling section — prefer `RichText` dataType with alias query |
| `Link<Asset>` | `Record` (Media) | url/width/height/alt/contentType |
| `Link<Entry>` | Nested DA or `Record` | Depends on target type complexity |
| `Array<Link<Entry>>` | `Array` of `Record` | Collection resolver |
| `Array<Symbol>` | `Array` of `String` | Tags, categories |

## Upsert Semantics & Conflict Handling

The `PUT /data_assemblies/:id` endpoint uses **upsert** semantics:
- First call creates the DA (no version header needed)
- Subsequent calls update (require `X-Contentful-Version` header)
- On `409 Conflict`: fetch current version, retry with updated header

```bash
# Upsert pattern with conflict retry
RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT \
  -H "Authorization: Bearer $CMA_TOKEN" \
  -H "Content-Type: application/json" \
  "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
  -d "$BODY")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" = "409" ]; then
  VERSION=$(curl -s -H "Authorization: Bearer $CMA_TOKEN" \
    "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
    | python3 -c "import sys, json; print(json.load(sys.stdin)['sys']['version'])")
  curl -s -X PUT \
    -H "Authorization: Bearer $CMA_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Contentful-Version: $VERSION" \
    "$API_HOST/spaces/$SPACE_ID/environments/$ENVIRONMENT_ID/data_assemblies/$DA_ID" \
    -d "$BODY"
fi
```

## Quick Decision Guide

Steps 0a and 0b decide *whether* to bind. Steps 1–3 decide *how*. Do not start at Step 1.

```
Step 0a: Is this request even about Data Assemblies?
  "Bind entries to components" / "wire up content" / "create DA"
    → YES, this skill. Continue.
  "Fill the empty slots" / "populate this page" / "fill in missing entries"
    → Instance-layer content binding. This skill creates the prerequisite
      recipes but does NOT attach bindings to instances. Name the layer,
      create the DAs, then say what remains per instance.
  "Place these components into the template" / "build the tree"
    → Assembly, not binding. Not this skill.

Step 0b: Is this property a content property?
  Changing the value changes WHAT IS SAID   → content property, continue
  Changing the value changes HOW IT LOOKS   → design property, STOP.
      Never bind it. Report as correctly-unmapped, not as a gap.
      (theme, variant, columns, alignment, backgroundColor, showDivider —
       still design properties when the value comes from the CMS)
  Is it public (present in the component type's contentProperties)?
    NO → STOP. Golden rule: never bind a non-public property.
         Required on the child but absent here? → flag as a possible
         auto-hoisting defect, not as intentionally private.

Step 1: What kind of component type?
  CODED → all contentProperties are public, go to Step 2
  COMPOSITE → check contentProperties list:
    Has contentProperties? → go to Step 2 (they're all public/hoisted)
    No contentProperties? → this composite doesn't need a DA
      (content arrives via slot children, each with their own DA)

Step 2: What feeds this content property?
  Single entry's field(s)?
    YES → Entity resolver (kind: "entity", _node query)
      Needs fields from a linked entry (reference)?
        YES → How complex is the linked entry?
          Simple (1-2 fields) → Scalar deep bind (traverse ref in GraphQL query)
          Complex (own component) → TypeRef deep bind (nested DA)
          Limit: ≤ 3 hops from root entry
        NO  → Single GraphQL resolver (shallow bind)
  Array of entries?
    YES → Collection resolver (kind: "collection", ...Collection query)
  Fixed value?
    YES → Use $literal in return (no resolver needed)
  Polymorphic source (multiple possible types)?
    YES → Use $on to branch on __typename

Step 3: Is this property on a slot child?
  YES → Create a SEPARATE DA for that child (do not include in parent DA)
  NO  → Include in the component's own DA
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Not classifying coded vs. composite first | Always classify — composites may not need a DA at all |
| Building a DA for a composite that only has slot children | If all content comes via slots, each child gets its own DA — parent needs none |
| Trying to hydrate slot children from the parent's DA | Slot boundary is absolute — each slot child needs its own DA |
| Using bare string pointers in `return` without checking reference | Default to `$from` syntax — bare pointers work but aren't editable in BindingPanel. Replicate reference space style if one exists. |
| Missing `__typename` in GraphQL query | Required for `$on` branching at runtime |
| Using CMA field IDs directly in GraphQL | GraphQL uses camelCase (e.g., `internalName` not `internal_name`) |
| Forgetting `kind: "collection"` for array resolvers | Without it, resolver returns single object not array |
| Setting `allowedTypes` to content type *name* instead of *ID* | Must be the programmatic ID (e.g., `topicProduct` not `Topic Product`) |
| Creating DA with same ID without version header | Fetch version first, or use upsert pattern |
| Mapping a property that isn't in `contentProperties` | Only the component's declared public properties are bindable |
| Hoisting per-property AND whole-component for same child | Mutually exclusive — pick one strategy |
| Not linking DA to the component type | After creating, add DA to the component type's `dataAssemblies` array — without this, it won't appear in the binding panel |
| Not publishing the DA after creation | Unpublished DAs not available for binding in editor |
| `sys.dataType` IDs don't match `contentProperties` IDs | They must be identical — the DA's dataType is the contract between resolver output and the component's input |
| Modeling images as bare `String` (URL only) | Use `Record` with url/width/height/alt/contentType |
| Mapping asset `alt` from the asset's `title` | `alt` comes from `description`, falling back to `title` only when `description` is empty across the sample — and say so in the Binding Plan when you fall back |
| Binding a design property because its value comes from the CMS | Apply the what-is-said / how-it-looks test. `theme`, `variant`, `alignment` are design properties regardless of source |
| Recording a required-but-unhoisted child property as "intentionally private" | Required properties are auto-hoisted — absence is a possible modeling defect. Flag it |
| Mapping a low-confidence guess to fill out the plan | Leave it unmapped and name it. A wrong mapping produces plausible content in the right shape, so nobody notices it |
| Answering "out of scope" to a "fill the empty slots" request | Name the layer it belongs to and what remains after the DAs exist |
| Using `$from` syntax for RichText fields | RichText requires bare string pointers to the parent object. `$from` causes "expected RichText, got String" |
| Declaring RichText as `String` dataType to avoid validation | Use `RichText` dataType + `{ document: json }` alias + bare parent pointer. The platform resolves it natively |
| Pointing to `/json` or `/document` leaf for RichText | Point to the parent (e.g., `$resolvers/main/ct/subline`). The platform reads the aliased `document` key itself |
| Omitting `sys.id` from PUT body | API rejects with "Invalid input at sys.id" — always include `"id": "$DA_ID"` in the sys object |
| Creating duplicate DAs for components sharing the same content property IDs | Create ONE DA and link it to multiple component types in step 7 |

## After Creation: Complete Binding Map (MANDATORY)

**You MUST produce this table at the end of every run.** Do not skip it. This is the deliverable that confirms all bindings are accounted for.

After all DAs are created, published, and linked, output a complete binding map covering EVERY component type in the space that has content properties:

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                        COMPLETE BINDING MAP                                  ║
╠══════════════════════════════════════════════════════════════════════════════╣

Component Type: HeroBanner (coded)
  DA: hero-banner-page-hero ✓ created ✓ published ✓ linked
  ┌─────────────────┬────────────────────┬───────────────────────────────────┐
  │ Content Property │ Source Field       │ Return Path                       │
  ├─────────────────┼────────────────────┼───────────────────────────────────┤
  │ title (String)  │ pageHero.headline  │ $resolvers/r1 → _node/headline    │
  │ subtitle (Str)  │ pageHero.subline   │ $resolvers/r1 → _node/subline     │
  │ image (Record)  │ pageHero.bgImage   │ $resolvers/r1 → _node/bgImage/*   │
  │ ctaLabel (Str)  │ pageHero.ctaText   │ $resolvers/r1 → _node/ctaText     │
  └─────────────────┴────────────────────┴───────────────────────────────────┘

Component Type: ProductSection (composite)
  DA: product-section-data ✓ created ✓ published ✓ linked
  ┌─────────────────┬─────────────────────────┬────────────────────────────────┐
  │ Content Property │ Source Field            │ Return Path                    │
  ├─────────────────┼─────────────────────────┼────────────────────────────────┤
  │ title (String)  │ productSection.headline │ $resolvers/r1 → _node/headline │
  └─────────────────┴─────────────────────────┴────────────────────────────────┘
  Slots:
    products → ProductGrid (has own DA: product-grid-catalog ✓)

Component Type: ProductGrid (coded, slot child)
  DA: product-grid-catalog ✓ created ✓ published ✓ linked
  ┌─────────────────────────┬──────────────────────────┬───────────────────────┐
  │ Content Property         │ Source Field             │ Return Path           │
  ├─────────────────────────┼──────────────────────────┼───────────────────────┤
  │ trendingProducts (Array)│ catalog.productsCol.items│ $resolvers/r1 → ...   │
  └─────────────────────────┴──────────────────────────┴───────────────────────┘

Component Type: Divider (coded)
  DA: none needed (no content properties)

╠══════════════════════════════════════════════════════════════════════════════╣
║ SUMMARY                                                                      ║
╠══════════════════════════════════════════════════════════════════════════════╣
  Total component types: 4
  DAs created: 3
  DAs skipped (no content props): 1
  Unbound content properties: 0  ← MUST be 0 to complete
╚══════════════════════════════════════════════════════════════════════════════╝
```

**Rules for the binding map:**
1. List EVERY component type in the space — even those that need no DA (mark as "none needed")
2. For each DA: show ✓/✗ for created, published, and linked status
3. For each content property: show the source field and return path
4. For composites: show slot children and whether they have their own DAs
5. The **Unbound content properties** count MUST be 0 — if any content property has no DA mapping, either create a DA for it or explicitly note why it's intentionally unbound (e.g., "always manually filled")
6. If any property is unbound without justification, go back and create the missing DA before outputting the final map

**After the map, print:**

1. All DAs created and published: `{list of DA IDs}`
2. To use them: open an Experience or Fragment in the Contentful editor
3. Select a component instance → Content tab → choose the relevant Data Assembly
4. Assign a source entry (of the allowed content type) as the parameter
5. For composites with slots: select each slot child individually and bind its own DA

## Operating Principles

1. **Introspect before designing** — do not invent content-type fields, content properties, or IDs. The space's schemas are the source of truth.
2. **Content properties ≠ content-type fields** — a content property is the *target* (on the component); a content-type field is the *source* (on the entry). They often have different names.
3. **Validate paths against content-type metadata** — a return mapping like `_node/headline` must correspond to an actual field on the source content type.
4. **IDs are stable contracts** — DA IDs, parameter IDs, and dataType IDs form contracts. Display names can change; IDs cannot after publication without a migration.
5. **Reference traversal is typed** — `_node/author/name` means "follow the `author` reference, then read `name`". Each segment must be a valid field on the resolved type at that depth.
6. **Only public properties are bindable** — if a property isn't in the component type's `contentProperties` array, it cannot be targeted regardless of whether it exists internally. Never bind, override, or map a property that is not public.
7. **Propose before creating** — if the mapping between source fields and target properties is ambiguous (similar names, multiple candidates), present options and confirm.
8. **Content, not presentation** — a mapping target must pass the what-is-said / how-it-looks test. CMS-authored design values (`theme`, `variant`) are still design properties.
9. **Every `return` key fills a declared content property** — the tree reads only through `$contentProperties/...`, so a mapping that fills nothing is dead weight, not a spare.
10. **An absent mapping beats a wrong one** — leave low-confidence properties unmapped and name them in the Binding Plan. Wrong mappings produce plausible content in the right shape and are hard to spot.
11. **Never claim to have unbound, replaced, or rewired anything** — existing DAs are reused or extended, never silently displaced.

## Limitations

- This skill creates Data Assemblies and links them to component types — it does not attach content bindings to experience/fragment instances
- GraphQL introspection not available via CMA — field names inferred from content type definitions
- Nested DA composition requires the referenced DA to already exist and be published
- `$on` type discriminator uses GraphQL `__typename` (PascalCase of content type ID)
- If a needed property is not hoisted (private), this skill cannot fix it — component type must be updated first
- Composites with no `contentProperties` don't need DAs — all content flows through slot children
- The pointer language has no coalesce operator, so per-value fallbacks (e.g. asset `description` → `title`) cannot be expressed in a DA. They are resolved at design time by sampling; see § 6.4
- The CMA returns **both drafts and published entries with no preference between them**. Nothing in a DA's parameter definition can express "prefer published" — `allowedTypes` filters by content type only. If publication state matters for a component, it has to be handled by the marketer at bind time or by the source content model, not here

## Provenance

The procedure, resolver patterns, GraphQL conventions, and API call sequences here were developed against live spaces. The judgment layer — the content-vs-design test, public/private and the golden rule, "should a property be public?", the slot-vs-content-binding distinction and request routing, and source-selection confidence — is adapted from `contentful-labs/exo-agent-skills-preview` → `exo-content-binding` (internal, PIC-1323).

The entity model, hoisting rules, and the Media-as-`Record` rule ultimately trace to `contentful/exo-upgrade-agent` → `assets/specs/` (`ExO-API-data-assemblies.md`, `ExO-API-hoisting-and-content-binding.spec.md`) and `modeling-goals.md`. Where those specs and this file disagree, the specs win — report the discrepancy rather than following this file.