/**
 * v1_basic_agent.ts
 * 
 * Core Philosophy: "the Model is the Agent"
 * 
 * Traditional Assistant:
 *  User -> Model -> Text Response
 * 
 * Agent System:
 *  User -> Model -> [Tool -> Result] -> Text Response
 *                   ^___________|
 * 
 * The Result to Tool matters. The Model calls tools REPEATEDLY until it decides the task is complete.
 * This transform a chatbot into an agent.
 * 
 * KEY INSIGHT: The Model is the decision-makeer. Code just provides tools and runs the loop. The Model decides:
 *  - When to call a tool
 *  - Which tool to call
 *  - How to combine tool results
 * 
 * This is a very powerful idea. It means that you can build an agent with just a Model and some tools.
 * You don't need to write any code to make the agent work.
 * 
 * 
 * The Four tools
 *  - bash: Execute shell commands
 *  - write: Write to a file
 *  - read: Read from a file
 *  - edit: Edit a file
 * 
 * 
 * With just these 4 tools, the model can:
 *   - explore codebases(bash: find grep, ls)
 *   - Understand code (read)
 *   - Make changes (write, edit)
 *   - Run anything (bash: bun, node, python, etc.)
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageFunctionToolCall, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources';
import { $ } from 'bun';
import { resolve } from "path";

const WORKSPACE_DIR = process.cwd();
const client = new OpenAI({
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
});

const systemPrompt = `You are a coding agent at ${WORKSPACE_DIR}. ` + 
`
Loop: think briefly, then call tools, then think again, repeat until task is complete.

Rules: 
- Prefer tools over prose. Act, don't just explain.
- Never invent file paths. Use bash ls/find first if unsure.
- Make minimal changes. Don't over-engineer.
- After finishing, summarize what changed.
`

const tools: ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'bash',
            description: 'Execute a bash command. Use for: ls, cd, pwd, mkdir, rm, cp, mv, node, bun, python, etc.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The bash command to execute' },
                },
                required: ['command'],
            },
        }
    },
    {
        type: 'function',
        function: {
            name: 'write',
            description: 'Write content to a file. Creates parent directories if needed.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path for the file to write to' },
                    content: { type: 'string', description: 'The content to write to the file' },
                },
                required: ['path', 'content'],
            },
        }
    },
    {
        type: 'function',
        function: {
            name: 'read',
            description: 'Read file contents. Return UTF-8 text.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path for the file to read from' },
                    lineLimit: { type: 'number', description: 'Maximum number of lines to read (optional)' },
                },
                required: ['path'],
            },
        }
    },
    {
        type: 'function',
        function: {
            name: 'edit',
            description: 'Edit file contents. Use for small changes: fix typos, add comments, refactor code.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path for the file to edit' },
                    old_content: { type: 'string', description: 'Exact text to find (must match exactly)' },
                    new_content: { type: 'string', description: 'Exact replacement text' },
                },
                required: ['path', 'old_content', 'new_content'],
            },
        }
    },
];

// tool functions

function isSafePath(path: string): boolean {
    const absWorkspace = resolve(WORKSPACE_DIR);
    const absTarget = resolve(WORKSPACE_DIR, path);
    return absTarget === absWorkspace || absTarget.startsWith(absWorkspace + "/");
}

async function bash(command: string): Promise<string> {
    const dangerousCommands = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerousCommands.some(cmd => command.includes(cmd))) {
        throw new Error(`Dangerous command: ${command}`);
    }

    try {
        const result = await $`bash -c ${command}`.quiet();
        return result.stdout.toString() || result.stderr.toString() || '';
    } catch (error: any) {
        throw new Error(`Error executing command: ${error.message}`);
    }
}

async function write(path: string, content: string): Promise<string> {
    if (!isSafePath(path)) {
        throw new Error(`Unsafe path: ${path}`);
    }
    await Bun.write(path, content);
    return `Wrote ${path}`;
}

async function read(path: string, lineLimit?: number): Promise<string> {
    if (!isSafePath(path)) {
        throw new Error(`Unsafe path: ${path}`);
    }
    const content = await Bun.file(path).text();
    
    const lines = content.split('\n');
    if (lineLimit !== undefined && lines.length > lineLimit) {
        const limitedLines = lines.slice(0, lineLimit);
        return limitedLines.join('\n') +
                `\n\n... truncated (${lines.length - lineLimit} more lines)`;
    }
    return content;
}

async function edit(path: string, old_content: string, new_content: string): Promise<string> {
    if (!isSafePath(path)) {
        throw new Error(`Unsafe path: ${path}`);
    }
    const content = await Bun.file(path).text();
    
    if (!content.includes(old_content)) {
        throw new Error(`Pattern not found in ${path}`);
    }
    const occurrences = content.split(old_content).length - 1;
    if (occurrences > 1) {
        throw new Error(`Pattern appears ${occurrences} times, must be unique`);
    }
    const newContent = content.replace(old_content, new_content);
    await Bun.write(path, newContent);
    return `Edited ${path}`;
}

async function executeCommand(command: string, args: Record<string, any>): Promise<string> {
    switch (command) {
        case 'bash':
            return await bash(args.command);
        case 'write':
            return await write(args.path, args.content);
        case 'read':
            return await read(args.path, args.lineLimit);
        case 'edit':
            return await edit(args.path, args.old_content, args.new_content);
        default:
            throw new Error(`Unknown command: ${command}`);
    }
}

async function agent(messages: ChatCompletionMessageParam[]): Promise<ChatCompletionMessageParam[]> {
    while (true) {
        try {
            const response = await client.chat.completions.create({
                model: process.env.AI_MODEL,
                messages: messages,
                tools: tools,
                tool_choice: 'auto',
            });

            const choice = response.choices[0];
            const finishReason = choice?.finish_reason;
            const assistantMessage = choice?.message;
            
            if (!assistantMessage) {
                break;
            }

            // Print assistant's text output if any
            if (assistantMessage.content && typeof assistantMessage.content === 'string') {
                console.log(`\n${assistantMessage.content}`);
            }

            const results: ChatCompletionMessageParam[] = [];

            // Push assistant message first (contains tool_calls if any)
            messages.push(assistantMessage);

            // Use finish_reason to determine next action
            if (finishReason === 'tool_calls') {
                // Model wants to call tools, process them
                if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                    // Process all tool calls
                    for (const toolCall of assistantMessage.tool_calls) {
                        const functionToolCall = toolCall as ChatCompletionMessageFunctionToolCall;
                        const toolName = functionToolCall.function.name;
                        
                        try {
                            // Parse the JSON arguments
                            const args = JSON.parse(functionToolCall.function.arguments);

                            console.log(`🔧 ${toolName}(${JSON.stringify(args)})`);
                            const result = await executeCommand(toolName, args);

                            // Only print preview of result (max 200 chars)
                            const preview = result.length > 200
                                ? result.slice(0, 200) + '...'
                                : result;
                            console.log(`  ${preview}\n`);

                            results.push({
                                role: 'tool',
                                content: result,
                                tool_call_id: functionToolCall.id,
                            });
                        } catch (error: any) {
                            console.error(`  Error: ${error.message}\n`);
                            results.push({
                                role: 'tool',
                                content: `Error: ${error.message}`,
                                tool_call_id: functionToolCall.id,
                            });
                        }
                    }
                    // Push all tool results
                    messages.push(...results);
                    // Continue the loop to get the next response after tool execution
                    continue;
                }
            } else if (finishReason === 'stop') {
                // Model finished normally, we're done
                break;
            } else if (finishReason === 'length') {
                // Hit token limit, warn and break
                console.warn('⚠️  Response truncated due to length limit');
                break;
            } else if (finishReason === 'content_filter') {
                // Content was filtered, stop
                console.warn('⚠️  Response filtered by content policy');
                break;
            } else {
                // Unknown finish_reason, log and break to be safe
                console.warn(`⚠️  Unknown finish_reason: ${finishReason}`);
                break;
            }
        } catch (error: any) {
            console.error('Error in chat loop:', error);
            messages.push({
                role: 'assistant',
                content: `Error: ${error.message}`,
            });
            break;
        }
    }
    return messages;
}

async function main() {
    // 处理命令行参数模式（单次执行）
    const args = process.argv.slice(2);
    if (args.length > 0) {
        const prompt = args.join(' ');
        const history: ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
        ];
        await agent(history);
        return;  // 单次模式，执行完退出
    }

    // REPL (Read-Eval-Print-Loop) 模式（连续对话）
    console.log(`\n🤖 Mini Claude Code v1 - ${WORKSPACE_DIR}`);
    console.log(`Type 'exit' to quit.\n`);

    const inquirer = (await import('inquirer')).default;
    const history: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
    ];


    while (true) {
        try {
            const { prompt } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'prompt',
                    message: 'You:',
                },
            ]);

            // 检查退出命令
            if (!prompt || ['exit', 'quit', 'q'].includes(prompt.toLowerCase().trim())) {
                console.log('\nGoodbye! 👋\n');
                break;
            }

            // 添加用户消息到历史
            history.push({
                role: 'user',
                content: prompt,
            });

            try {
                // 运行 agent（会修改 history）
                await agent(history);
            } catch (error: any) {
                console.error(`\n❌ Error: ${error.message}\n`);
            }

            console.log();  // 空行分隔每轮对话
        } catch (error) {
            // Ctrl+C 或其他中断
            console.log('\nGoodbye! 👋\n');
            break;
        }
    }
}

main().catch(console.error);