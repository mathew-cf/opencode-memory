/**
 * One tool definition, two plugin surfaces.
 *
 * OpenCode V1 wants a `tool()` object with zod `args`; OpenCode V2 wants a
 * definition with a JSON Schema `input` and a structured result. Rather than
 * maintaining two copies of every description, every tool in this package is
 * declared once as a {@link ToolSpec} — JSON Schema is the source of truth —
 * and {@link defineTool} derives the V1 zod shape from it.
 *
 * `execute` stays exactly what it always was: plain arguments in, string out.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin";

/** The JSON Schema subset this package's tools actually use. */
export interface ToolInputProperty {
  type: "string" | "number" | "boolean";
  description?: string;
  enum?: readonly string[];
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, ToolInputProperty>;
  required?: readonly string[];
  additionalProperties: false;
  /** Keeps the shape assignable to OpenCode V2's open JSON Schema type. */
  [keyword: string]: unknown;
}

/** The slice of tool-call context both plugin versions can supply. */
export interface ToolSpecContext {
  sessionID?: string;
}

export interface ToolSpec<Input> {
  /** Effective tool name, e.g. `memory_search`. */
  name: string;
  description: string;
  input: ToolInputSchema;
  execute(input: Input, context: ToolSpecContext): Promise<string>;
}

export interface MemoryTool<Input = Record<string, unknown>> extends ToolSpec<Input> {
  /** The OpenCode V1 `tool()` definition derived from this spec. */
  readonly v1: ToolDefinition;
}

/**
 * Build the zod `args` shape a V1 `tool()` expects from a JSON Schema object.
 * Only the property kinds declared in {@link ToolInputProperty} are handled —
 * anything else is a programming error and throws at module load, which is
 * exactly when we want to hear about it.
 *
 * The casts exist because `tool.schema` is re-exported zod whose concrete
 * class types don't survive the zod-v3-vs-v4 drift in transitive deps; the
 * builder chain is structurally stable even when the nominal types aren't.
 */
interface ZodChain {
  describe(description: string): ZodChain;
  optional(): ZodChain;
}

export function toolArgsFromSchema(input: ToolInputSchema): ToolDefinition["args"] {
  const required = new Set(input.required ?? []);
  const args: Record<string, ZodChain> = {};

  for (const [name, property] of Object.entries(input.properties)) {
    let schema: ZodChain;
    if (property.enum) {
      const values = [...property.enum] as [string, ...string[]];
      schema = tool.schema.enum(values) as unknown as ZodChain;
    } else if (property.type === "number") {
      schema = tool.schema.number() as unknown as ZodChain;
    } else if (property.type === "boolean") {
      schema = tool.schema.boolean() as unknown as ZodChain;
    } else if (property.type === "string") {
      schema = tool.schema.string() as unknown as ZodChain;
    } else {
      throw new Error(`Unsupported tool input type for "${name}": ${String(property.type)}`);
    }

    if (property.description) schema = schema.describe(property.description);
    if (!required.has(name)) schema = schema.optional();
    args[name] = schema;
  }

  return args as unknown as ToolDefinition["args"];
}

/** Declare a tool once and get both plugin surfaces back. */
export function defineTool<Input>(spec: ToolSpec<Input>): MemoryTool<Input> {
  const v1: ToolDefinition = tool({
    description: spec.description,
    args: toolArgsFromSchema(spec.input),
    async execute(args, context) {
      return spec.execute(args as Input, { sessionID: context?.sessionID });
    },
  });

  return { ...spec, v1 };
}
