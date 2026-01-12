/**
 * Template syntax parser.
 *
 * Parses Handlebars-style templates with:
 * - Variables: {{variable}} or {{var | modifier:arg}}
 * - Conditionals: {{#if condition}}...{{else}}...{{/if}}
 * - Loops: {{#each items}}...{{/each}}
 */

import type {
  TemplateNode,
  TextNode,
  VariableNode,
  ConditionalNode,
  LoopNode,
  ModifierCall,
  ParsedTemplate,
} from "./types.js";

// Regex patterns
const OPEN_TAG = /\{\{/g;
const CLOSE_TAG = /\}\}/g;
const VARIABLE_PATTERN = /^\{\{([^#/].*?)\}\}$/s;
const BLOCK_OPEN_PATTERN = /^\{\{#(\w+)\s+(.*?)\}\}$/s;
const BLOCK_CLOSE_PATTERN = /^\{\{\/(\w+)\}\}$/;
const ELSE_PATTERN = /^\{\{else(?:\s+if\s+(.*?))?\}\}$/s;

/**
 * Parse template content into an AST.
 */
export function parseTemplate(content: string): ParsedTemplate {
  const tokens = tokenize(content);
  const { nodes, variables, modifiers } = parseTokens(tokens);

  return {
    nodes,
    variables,
    modifiers,
  };
}

/**
 * Tokenize template content into raw tokens.
 */
function tokenize(content: string): string[] {
  const tokens: string[] = [];
  let current = 0;
  let tagStart = -1;

  while (current < content.length) {
    // Look for {{
    if (content[current] === "{" && content[current + 1] === "{") {
      // Save any text before this tag
      if (tagStart === -1 && current > 0) {
        const textBefore = content.slice(tokens.length === 0 ? 0 : tokens.reduce((sum, t) => sum + t.length, 0), current);
        if (textBefore) tokens.push(textBefore);
      }
      tagStart = current;
      current += 2;
      continue;
    }

    // Look for }}
    if (content[current] === "}" && content[current + 1] === "}" && tagStart !== -1) {
      const tag = content.slice(tagStart, current + 2);
      tokens.push(tag);
      tagStart = -1;
      current += 2;
      continue;
    }

    current++;
  }

  // Add any remaining text
  if (tagStart === -1) {
    const lastEnd = tokens.reduce((sum, t) => sum + t.length, 0);
    if (lastEnd < content.length) {
      tokens.push(content.slice(lastEnd));
    }
  }

  return tokens;
}

/**
 * Simpler tokenizer that handles the content correctly.
 */
function tokenizeSimple(content: string): string[] {
  const tokens: string[] = [];
  let pos = 0;

  while (pos < content.length) {
    const openIdx = content.indexOf("{{", pos);

    if (openIdx === -1) {
      // No more tags, rest is text
      if (pos < content.length) {
        tokens.push(content.slice(pos));
      }
      break;
    }

    // Add text before tag
    if (openIdx > pos) {
      tokens.push(content.slice(pos, openIdx));
    }

    // Find closing }}
    const closeIdx = content.indexOf("}}", openIdx);
    if (closeIdx === -1) {
      // Unclosed tag, treat rest as text
      tokens.push(content.slice(openIdx));
      break;
    }

    // Add the tag
    tokens.push(content.slice(openIdx, closeIdx + 2));
    pos = closeIdx + 2;
  }

  return tokens;
}

/**
 * Parse tokens into AST nodes.
 */
function parseTokens(tokens: string[]): {
  nodes: TemplateNode[];
  variables: Set<string>;
  modifiers: Set<string>;
} {
  // Use simple tokenizer
  const actualTokens = tokens.length === 1 ? tokenizeSimple(tokens[0]) : tokens;

  const nodes: TemplateNode[] = [];
  const variables = new Set<string>();
  const modifiers = new Set<string>();
  let i = 0;

  while (i < actualTokens.length) {
    const token = actualTokens[i];

    // Check if it's a tag
    if (token.startsWith("{{") && token.endsWith("}}")) {
      // Block open tag
      const blockOpenMatch = token.match(BLOCK_OPEN_PATTERN);
      if (blockOpenMatch) {
        const [, blockType, expression] = blockOpenMatch;

        if (blockType === "if" || blockType === "unless") {
          const { node, endIndex } = parseConditional(
            actualTokens,
            i,
            blockType,
            expression,
            variables,
            modifiers
          );
          nodes.push(node);
          i = endIndex + 1;
          continue;
        }

        if (blockType === "each") {
          const { node, endIndex } = parseLoop(actualTokens, i, expression, variables, modifiers);
          nodes.push(node);
          i = endIndex + 1;
          continue;
        }

        // Unknown block type, treat as text
        nodes.push({ type: "text", content: token });
        i++;
        continue;
      }

      // Variable tag
      const varMatch = token.match(VARIABLE_PATTERN);
      if (varMatch) {
        const varNode = parseVariableExpression(varMatch[1].trim(), variables, modifiers);
        varNode.raw = token;
        nodes.push(varNode);
        i++;
        continue;
      }

      // Unknown tag format, treat as text
      nodes.push({ type: "text", content: token });
      i++;
      continue;
    }

    // Plain text
    nodes.push({ type: "text", content: token });
    i++;
  }

  return { nodes, variables, modifiers };
}

/**
 * Parse a variable expression like "name | upper | truncate:50".
 */
function parseVariableExpression(
  expression: string,
  variables: Set<string>,
  modifiersSet: Set<string>
): VariableNode {
  const parts = expression.split("|").map((p) => p.trim());
  const name = parts[0];
  const modifierCalls: ModifierCall[] = [];

  variables.add(name.split(".")[0]); // Add root variable name

  for (let i = 1; i < parts.length; i++) {
    const modifierPart = parts[i];
    const colonIdx = modifierPart.indexOf(":");
    let modifierName: string;
    let args: string[] = [];

    if (colonIdx === -1) {
      modifierName = modifierPart;
    } else {
      modifierName = modifierPart.slice(0, colonIdx);
      const argsStr = modifierPart.slice(colonIdx + 1);
      args = parseModifierArgs(argsStr);
    }

    modifiersSet.add(modifierName);
    modifierCalls.push({ name: modifierName, args });
  }

  return {
    type: "variable",
    name,
    modifiers: modifierCalls,
    raw: "",
  };
}

/**
 * Parse modifier arguments, handling quoted strings.
 */
function parseModifierArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let i = 0;

  while (i < argsStr.length) {
    const char = argsStr[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      inQuote = char;
    } else if (char === ":") {
      args.push(current);
      current = "";
    } else {
      current += char;
    }
    i++;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

/**
 * Parse a conditional block.
 */
function parseConditional(
  tokens: string[],
  startIndex: number,
  blockType: string,
  expression: string,
  variables: Set<string>,
  modifiers: Set<string>
): { node: ConditionalNode; endIndex: number } {
  const condition = parseVariableExpression(expression, variables, modifiers);
  const consequent: TemplateNode[] = [];
  const alternate: TemplateNode[] = [];
  let currentBranch = consequent;
  let depth = 1;
  let i = startIndex + 1;

  while (i < tokens.length && depth > 0) {
    const token = tokens[i];

    if (token.startsWith("{{") && token.endsWith("}}")) {
      // Check for nested block open
      const blockOpenMatch = token.match(BLOCK_OPEN_PATTERN);
      if (blockOpenMatch && (blockOpenMatch[1] === "if" || blockOpenMatch[1] === "unless")) {
        depth++;
      }

      // Check for block close
      const blockCloseMatch = token.match(BLOCK_CLOSE_PATTERN);
      if (blockCloseMatch && blockCloseMatch[1] === "if") {
        depth--;
        if (depth === 0) {
          return {
            node: {
              type: "conditional",
              condition,
              inverse: blockType === "unless",
              consequent,
              alternate: alternate.length > 0 ? alternate : undefined,
            },
            endIndex: i,
          };
        }
      }

      // Check for else (only at depth 1)
      if (depth === 1) {
        const elseMatch = token.match(ELSE_PATTERN);
        if (elseMatch) {
          currentBranch = alternate;
          i++;
          continue;
        }
      }
    }

    // Parse content for current branch
    if (token.startsWith("{{") && token.endsWith("}}")) {
      const varMatch = token.match(VARIABLE_PATTERN);
      if (varMatch) {
        const varNode = parseVariableExpression(varMatch[1].trim(), variables, modifiers);
        varNode.raw = token;
        currentBranch.push(varNode);
      } else {
        // Nested block or other tag
        const blockOpenMatch = token.match(BLOCK_OPEN_PATTERN);
        if (blockOpenMatch) {
          const [, nestedType, nestedExpr] = blockOpenMatch;
          if (nestedType === "if" || nestedType === "unless") {
            const { node, endIndex } = parseConditional(
              tokens,
              i,
              nestedType,
              nestedExpr,
              variables,
              modifiers
            );
            currentBranch.push(node);
            i = endIndex;
          } else if (nestedType === "each") {
            const { node, endIndex } = parseLoop(tokens, i, nestedExpr, variables, modifiers);
            currentBranch.push(node);
            i = endIndex;
          }
        }
      }
    } else {
      currentBranch.push({ type: "text", content: token });
    }

    i++;
  }

  // Unclosed block - return what we have
  return {
    node: {
      type: "conditional",
      condition,
      inverse: blockType === "unless",
      consequent,
      alternate: alternate.length > 0 ? alternate : undefined,
    },
    endIndex: i - 1,
  };
}

/**
 * Parse a loop block.
 */
function parseLoop(
  tokens: string[],
  startIndex: number,
  expression: string,
  variables: Set<string>,
  modifiers: Set<string>
): { node: LoopNode; endIndex: number } {
  const iterable = expression.trim();
  variables.add(iterable.split(".")[0]);

  const body: TemplateNode[] = [];
  const empty: TemplateNode[] = [];
  let currentBranch = body;
  let depth = 1;
  let i = startIndex + 1;

  while (i < tokens.length && depth > 0) {
    const token = tokens[i];

    if (token.startsWith("{{") && token.endsWith("}}")) {
      // Check for nested each
      const blockOpenMatch = token.match(BLOCK_OPEN_PATTERN);
      if (blockOpenMatch && blockOpenMatch[1] === "each") {
        depth++;
      }

      // Check for close
      const blockCloseMatch = token.match(BLOCK_CLOSE_PATTERN);
      if (blockCloseMatch && blockCloseMatch[1] === "each") {
        depth--;
        if (depth === 0) {
          return {
            node: {
              type: "loop",
              iterable,
              itemName: "this",
              body,
              empty: empty.length > 0 ? empty : undefined,
            },
            endIndex: i,
          };
        }
      }

      // Check for else (only at depth 1)
      if (depth === 1) {
        const elseMatch = token.match(ELSE_PATTERN);
        if (elseMatch && !elseMatch[1]) {
          // Plain {{else}} without condition
          currentBranch = empty;
          i++;
          continue;
        }
      }
    }

    // Parse content for current branch
    if (token.startsWith("{{") && token.endsWith("}}")) {
      const varMatch = token.match(VARIABLE_PATTERN);
      if (varMatch) {
        const varNode = parseVariableExpression(varMatch[1].trim(), variables, modifiers);
        varNode.raw = token;
        currentBranch.push(varNode);
      } else {
        // Nested block
        const blockOpenMatch = token.match(BLOCK_OPEN_PATTERN);
        if (blockOpenMatch) {
          const [, nestedType, nestedExpr] = blockOpenMatch;
          if (nestedType === "if" || nestedType === "unless") {
            const { node, endIndex } = parseConditional(
              tokens,
              i,
              nestedType,
              nestedExpr,
              variables,
              modifiers
            );
            currentBranch.push(node);
            i = endIndex;
          } else if (nestedType === "each") {
            const { node, endIndex } = parseLoop(tokens, i, nestedExpr, variables, modifiers);
            currentBranch.push(node);
            i = endIndex;
          }
        }
      }
    } else {
      currentBranch.push({ type: "text", content: token });
    }

    i++;
  }

  return {
    node: {
      type: "loop",
      iterable,
      itemName: "this",
      body,
      empty: empty.length > 0 ? empty : undefined,
    },
    endIndex: i - 1,
  };
}

/**
 * Extract all variable names referenced in template content.
 */
export function extractVariableNames(content: string): string[] {
  const parsed = parseTemplate(content);
  return Array.from(parsed.variables);
}

/**
 * Extract all modifier names used in template content.
 */
export function extractModifierNames(content: string): string[] {
  const parsed = parseTemplate(content);
  return Array.from(parsed.modifiers);
}
