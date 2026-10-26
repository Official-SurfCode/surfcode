import type { ToolDefinition, ToolSchema } from '../core/types.js';
import { editTool, listTool, readTool, writeTool } from './files.js';
import {
  githubCommitTool,
  githubCreateRepoTool,
  githubStatusTool,
  githubUploadTool
} from './github.js';
import { globTool, grepTool } from './search.js';
import { shellTool } from './shell.js';
import { todoTool } from './todos.js';
import { webfetchTool } from './webfetch.js';

export function createTools(): ToolDefinition[] {
  return [
    readTool,
    writeTool,
    editTool,
    listTool,
    globTool,
    grepTool,
    shellTool,
    webfetchTool,
    todoTool,
    githubStatusTool,
    githubCreateRepoTool,
    githubUploadTool,
    githubCommitTool
  ];
}

export function toolSchemas(tools: ToolDefinition[]): ToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

export function findTool(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}
