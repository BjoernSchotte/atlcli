/**
 * Template rendering engine.
 */

import type {
  Template,
  TemplateContext,
  RenderedTemplate,
  TemplateNode,
  VariableNode,
  ConditionalNode,
  LoopNode,
  ModifierRegistry,
  VariableValues,
  BuiltinVariables,
} from "./types.js";
import { parseTemplate } from "./parser.js";
import { applyModifierChain, defaultModifiers } from "./modifiers.js";
import { resolveBuiltin, isBuiltinVariable } from "./builtins.js";

/**
 * Render a template with the given context.
 */
export function renderTemplate(
  template: Template,
  context: TemplateContext,
  modifiers: ModifierRegistry = defaultModifiers
): RenderedTemplate {
  const parsed = parseTemplate(template.content);
  const markdown = renderNodes(parsed.nodes, context, modifiers);

  // Render labels if they contain variables
  let labels: string[] | undefined;
  if (template.metadata.target?.labels) {
    labels = template.metadata.target.labels.map((label) => {
      if (label.includes("{{")) {
        const labelParsed = parseTemplate(label);
        return renderNodes(labelParsed.nodes, context, modifiers);
      }
      return label;
    });
  }

  return {
    markdown,
    title: context.title,
    spaceKey: context.spaceKey,
    parentId: context.parentId,
    labels,
  };
}

/**
 * Render a list of AST nodes.
 */
function renderNodes(
  nodes: TemplateNode[],
  context: TemplateContext,
  modifiers: ModifierRegistry
): string {
  let result = "";

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result += node.content;
        break;
      case "variable":
        result += renderVariable(node, context, modifiers);
        break;
      case "conditional":
        result += renderConditional(node, context, modifiers);
        break;
      case "loop":
        result += renderLoop(node, context, modifiers);
        break;
    }
  }

  return result;
}

/**
 * Render a variable node.
 */
function renderVariable(
  node: VariableNode,
  context: TemplateContext,
  modifiers: ModifierRegistry
): string {
  let value = resolveVariable(node.name, context);

  // Apply modifiers
  if (node.modifiers.length > 0) {
    value = applyModifierChain(value, node.modifiers, modifiers);
  }

  // Convert to string for output
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return String(value);
}

/**
 * Resolve a variable name to its value.
 */
function resolveVariable(name: string, context: TemplateContext): unknown {
  // Check for loop context variables
  if (name === "this") {
    return context.variables["this"];
  }
  if (name.startsWith("this.")) {
    const item = context.variables["this"];
    if (item === null || item === undefined) return undefined;
    return resolvePath(item, name.slice(5));
  }

  // Check for loop metadata
  if (name.startsWith("@")) {
    const metaName = name.slice(1);
    return context.variables[`@${metaName}`];
  }

  // Check if it's a builtin variable
  if (isBuiltinVariable(name)) {
    return resolveBuiltin(context.builtins, name);
  }

  // Check user variables
  const rootName = name.split(".")[0];
  if (rootName in context.variables) {
    if (name.includes(".")) {
      return resolvePath(context.variables[rootName], name.slice(rootName.length + 1));
    }
    return context.variables[rootName];
  }

  return undefined;
}

/**
 * Resolve a dot-separated path on an object.
 */
function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Render a conditional node.
 */
function renderConditional(
  node: ConditionalNode,
  context: TemplateContext,
  modifiers: ModifierRegistry
): string {
  // Evaluate condition
  let conditionValue = resolveVariable(node.condition.name, context);

  // Apply modifiers to get final condition value
  if (node.condition.modifiers.length > 0) {
    conditionValue = applyModifierChain(conditionValue, node.condition.modifiers, modifiers);
  }

  // Determine truthiness
  const isTruthy = Boolean(conditionValue) &&
    !(Array.isArray(conditionValue) && conditionValue.length === 0);

  // Apply inverse for {{#unless}}
  const shouldRenderConsequent = node.inverse ? !isTruthy : isTruthy;

  if (shouldRenderConsequent) {
    return renderNodes(node.consequent, context, modifiers);
  } else if (node.alternate) {
    return renderNodes(node.alternate, context, modifiers);
  }

  return "";
}

/**
 * Render a loop node.
 */
function renderLoop(
  node: LoopNode,
  context: TemplateContext,
  modifiers: ModifierRegistry
): string {
  // Resolve the iterable
  const resolved = resolveVariable(node.iterable, context);

  // Normalize to array
  let items: unknown[];
  if (Array.isArray(resolved)) {
    items = resolved;
  } else if (typeof resolved === "string") {
    // Might be a comma-separated list
    items = resolved.split(",").map((s) => s.trim());
  } else if (resolved === undefined || resolved === null) {
    items = [];
  } else {
    items = [resolved];
  }

  // If empty and we have an else block
  if (items.length === 0 && node.empty) {
    return renderNodes(node.empty, context, modifiers);
  }

  // Render each item
  let result = "";
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // Create loop context
    const loopContext: TemplateContext = {
      ...context,
      variables: {
        ...context.variables,
        this: item,
        "@index": i,
        "@number": i + 1,
        "@first": i === 0,
        "@last": i === items.length - 1,
        "@odd": i % 2 === 1,
        "@even": i % 2 === 0,
      },
    };

    result += renderNodes(node.body, loopContext, modifiers);
  }

  return result;
}

/**
 * Preview a template with given variables (for dry-run).
 */
export function previewTemplate(
  template: Template,
  variables: VariableValues,
  builtins: BuiltinVariables
): RenderedTemplate {
  const context: TemplateContext = {
    variables,
    builtins,
    spaceKey: builtins.SPACE.key,
    parentId: builtins.PARENT.id ?? undefined,
    title: builtins.TITLE,
  };

  return renderTemplate(template, context);
}

/**
 * Render a simple string with variable substitution (for labels, titles, etc.).
 */
export function renderString(
  str: string,
  context: TemplateContext,
  modifiers: ModifierRegistry = defaultModifiers
): string {
  if (!str.includes("{{")) {
    return str;
  }

  const parsed = parseTemplate(str);
  return renderNodes(parsed.nodes, context, modifiers);
}
