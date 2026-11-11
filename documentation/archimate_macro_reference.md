# ArchiMate Macro Reference for generate_archimate_diagram

Use this reference when you need to build a valid payload for `generate_archimate_diagram`.

## Purpose

`generate_archimate_diagram` expects ArchiMate PlantUML macros, not generic UML shapes.

You must choose the correct ArchiMate macro for each element before calling the tool.

Do not use generic PlantUML element syntax such as:
- `rectangle`
- `component`
- `node`
- `database`
- `cloud`
- stereotypes like `<<...>>`

Use ArchiMate macros only.

## Core Rule

A macro name is built as:

`<layer>_<artefact>`

Examples:
- `Strategy_Capability`
- `Business_Service`
- `Application_Component`
- `Technology_Node`
- `Physical_Equipment`
- `Motivation_Goal`
- `Implementation_WorkPackage`

This means that the same business word cannot be mapped arbitrarily.

Example:
- any object of type `capability` must use the macro `Strategy_Capability`
- not `Capability`
- not `Business_Capability`
- not any generic PlantUML syntax

## Responsibility of the Agent

It is the responsibility of the agent to map the source node type to the correct ArchiMate macro.

The tool does not infer the ArchiMate layer for you.

You must decide:
1. which ArchiMate layer applies
2. which ArchiMate artefact applies
3. which final macro must be used

Example:
- source type: `capability`
- target macro: `Strategy_Capability`

Example:
- source type: `business service`
- target macro: `Business_Service`

Example:
- source type: `data object`
- target macro: `Application_DataObject`

## Official ArchiMate Element Macros

### Strategy
- `Strategy_Resource`
- `Strategy_Capability`
- `Strategy_CourseOfAction`
- `Strategy_ValueStream`

### Business
- `Business_Actor`
- `Business_Role`
- `Business_Collaboration`
- `Business_Interface`
- `Business_Process`
- `Business_Function`
- `Business_Interaction`
- `Business_Event`
- `Business_Service`
- `Business_Object`
- `Business_Contract`
- `Business_Representation`
- `Business_Product`
- `Business_Location`

### Application
- `Application_Component`
- `Application_Collaboration`
- `Application_Interface`
- `Application_Function`
- `Application_Interaction`
- `Application_Process`
- `Application_Event`
- `Application_Service`
- `Application_DataObject`

### Technology
- `Technology_Node`
- `Technology_Device`
- `Technology_SystemSoftware`
- `Technology_Collaboration`
- `Technology_Interface`
- `Technology_Path`
- `Technology_CommunicationNetwork`
- `Technology_Function`
- `Technology_Process`
- `Technology_Interaction`
- `Technology_Event`
- `Technology_Service`
- `Technology_Artifact`

### Physical
- `Physical_Equipment`
- `Physical_Facility`
- `Physical_DistributionNetwork`
- `Physical_Material`

### Motivation
- `Motivation_Stakeholder`
- `Motivation_Driver`
- `Motivation_Assessment`
- `Motivation_Goal`
- `Motivation_Outcome`
- `Motivation_Principle`
- `Motivation_Requirement`
- `Motivation_Constraint`
- `Motivation_Meaning`
- `Motivation_Value`

### Implementation and Migration
- `Implementation_WorkPackage`
- `Implementation_Deliverable`
- `Implementation_Event`
- `Implementation_Plateau`
- `Implementation_Gap`

## Official ArchiMate Relationship Macros

Use these relationship macros in `relationships[].type`.

### Base relationship macros
- `Rel_Composition`
- `Rel_Aggregation`
- `Rel_Assignment`
- `Rel_Specialization`
- `Rel_Serving`
- `Rel_Association`
- `Rel_Association_dir`
- `Rel_Flow`
- `Rel_Realization`
- `Rel_Triggering`
- `Rel_Access`
- `Rel_Access_r`
- `Rel_Access_rw`
- `Rel_Access_w`
- `Rel_Influence`

### Directional variants

Each base relationship macro can also be used with directional suffixes:
- `_Up`
- `_Down`
- `_Left`
- `_Right`

Examples:
- `Rel_Composition_Right`
- `Rel_Realization_Up`
- `Rel_Influence_Left`
- `Rel_Access_rw_Down`

## Grouping vs Group vs Boundary

These three names do not mean the same thing in `mcp-plantuml`.

### `Grouping`

- `Grouping` exists in the PlantUML ArchiMate runtime used by this server
- it is valid in the tested PlantUML runtime (`1.2026.2`)
- use it when the modeled concept is explicitly an ArchiMate grouping concept
- if a source node has `modelizationClass = "Grouping"`, the target macro should be `Grouping`

Example:

```plantuml
Grouping(G1, "Business Area")
```

### `Group`

- `Group` is a grouping helper exposed by the ArchiMate stdlib/runtime
- use it as a visual container when you want to group elements in the diagram layout
- it is not the same modeling decision as using the ArchiMate concept `Grouping`

Example:

```plantuml
Group(G1, "Business Area")
```

### `Boundary`

- `Boundary` is used when you want to delimit a perimeter or scope
- use it for visual boundaries or contextual containers

Example:

```plantuml
Boundary(B1, "Application Landscape")
```

### Practical Rule

- use `Grouping` when the element itself is a `Grouping` concept
- use `Group` when you need a visual grouping container
- use `Boundary` when you need a perimeter or scope container

### Hard Rules

- never replace `Grouping` with `Boundary`
- never replace `Grouping` with `Group`
- if the source node has `modelizationClass = "Grouping"`, the macro must be `Grouping`
- a `Boundary` does not replace the ArchiMate type of the elements it contains
- elements inside a `Boundary` must still use explicit ArchiMate macros

Incorrect:

```plantuml
Boundary(BA, "Business Area")
Boundary(BD, "Business Domain")
Boundary(SD, "Service Domain")
```

Correct:

```plantuml
Boundary(BA, "Business Area")
Grouping(BD, "Business Domain")
Strategy_Capability(SD, "Service Domain")
```

### Important Clarification

Do not assume that `Grouping` is invalid.

In the PlantUML runtime used by this MCP server, both of the following are valid:
- `Grouping(...)`
- `Group(...)`

## MCP Server Extensions

The following fields are extensions provided by the `mcp-plantuml` server.

They are not part of the official ArchiMate PlantUML stdlib itself.

### Element-level MCP extensions

- `code`
  - explicit alias / identifier used by the server
- `note`
  - optional note text attached by the MCP server
  - this is not an official ArchiMate macro argument
- `description`
  - optional descriptive text consumed by the MCP layer
  - not an official ArchiMate macro argument
- `extra`
  - raw suffix appended by the MCP server when composing a macro call
  - not documented in the official ArchiMate library
- `raw`
  - full PlantUML line inserted verbatim by the MCP server
  - this bypasses normal macro composition

### Relationship-level MCP extensions

- `label`
  - supported by official `Rel_*` macros
- `raw_arrow`
  - MCP-only override to force a raw PlantUML arrow
- `raw`
  - full PlantUML line inserted verbatim

### Diagram-level MCP extensions

- `title`
  - diagram title injected by the server
- `layout`
  - server-level layout option such as `left_to_right`, `top_down`, or `sketch`
- `format`
  - output format such as `png` or `svg`
- `include_relationship_legend`
  - asks the MCP server to generate a legend block
- `legend_type`
  - legend variant generated by the MCP server
- `use_local_stdlib`
  - asks the server to reference a local stdlib copy when available
- `groups`
  - structured nesting model handled by the MCP server
- `elements`
  - structured element list handled by the MCP server
- `relationships`
  - structured relationship list handled by the MCP server

### Important Clarification

The official ArchiMate library defines macros such as:
- `Business_Service(...)`
- `Application_Component(...)`
- `Motivation_Principle(...)`
- `Grouping(...)`
- `Rel_Serving(...)`
- `Rel_Influence(...)`

It does **not** define JSON fields such as:
- `extra`
- `note`
- `layout`
- `legend_type`
- `use_local_stdlib`

Those are MCP-server features added on top of the official PlantUML ArchiMate library.

## Expected Structured JSON Shape

Use structured JSON when calling `generate_archimate_diagram`.

```json
{
  "title": "BIAN Service Domain Concept",
  "layout": "left_to_right",
  "elements": [
    {
      "macro": "Strategy_Capability",
      "label": "Service Domain",
      "code": "serviceDomain",
      "note": "Optional note"
    },
    {
      "macro": "Business_Object",
      "label": "Control Record",
      "code": "controlRecord"
    }
  ],
  "relationships": [
    {
      "type": "Rel_Composition",
      "from": "businessDomain",
      "to": "serviceDomain",
      "label": "composes"
    },
    {
      "type": "Rel_Access",
      "from": "serviceDomain",
      "to": "controlRecord",
      "label": "accesses"
    }
  ],
  "format": "png"
}
```

## Output Format Guidance

Prefer `png` for display in chat clients, embedded viewers, or application UI rendering.

Prefer `svg` for file-oriented output, archival quality, or when vector rendering is required.

## Rules for generate_archimate_diagram

- Use `macro` for elements
- Use `type` for relationships
- Use `from` and `to` for relationship endpoints
- `code`, `note`, `description`, `extra`, `raw`, `layout`, `format`, and legend options are MCP-server extensions
- Use ArchiMate macros only
- Do not use generic PlantUML syntax
- Do not invent unofficial macros
- Do not use `Capability` alone
- Use `Strategy_Capability` for capabilities
- Never replace `Grouping` with `Boundary`
- Never use `Boundary` as a substitute for a typed ArchiMate element
- Elements nested inside `Boundary` or `Group` must still have their own explicit ArchiMate macro
- Use directional relationship variants only when layout control is required

## Example Mapping Decisions

- `capability` -> `Strategy_Capability`
- `resource` -> `Strategy_Resource`
- `business actor` -> `Business_Actor`
- `business process` -> `Business_Process`
- `business service` -> `Business_Service`
- `application component` -> `Application_Component`
- `application function` -> `Application_Function`
- `data object` -> `Application_DataObject`
- `node` -> `Technology_Node`
- `device` -> `Technology_Device`
- `artifact` -> `Technology_Artifact`
- `equipment` -> `Physical_Equipment`
- `goal` -> `Motivation_Goal`
- `requirement` -> `Motivation_Requirement`
- `work package` -> `Implementation_WorkPackage`

## Final Guidance

Before calling `generate_archimate_diagram`:
1. map each source node type to the correct ArchiMate macro
2. map each source relationship to the correct `Rel_*` macro
3. build a structured JSON payload
4. avoid all generic UML fallback syntax
5. do not replace typed elements with `Boundary` containers
