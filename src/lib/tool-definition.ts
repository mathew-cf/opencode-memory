import { z } from "zod/v4";

export interface ToolContext {
  sessionID: string;
}

export interface ToolDefinition {
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  execute(input: any, context: ToolContext): Promise<{ content: string }>;
}

export function defineTool<Shape extends z.ZodRawShape>(definition: {
  description: string;
  input: z.ZodObject<Shape>;
  execute(input: z.infer<z.ZodObject<Shape>>, context: ToolContext): Promise<{ content: string }>;
}) {
  return definition;
}
