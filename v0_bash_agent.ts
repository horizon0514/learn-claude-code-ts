/**
 * v0_bash_agent.ts
 * 
 * Core Philosophy: bash is all you need.
 * 
 * Features:
 *  - Read files
 *  - Write files
 *  - Search: find, grep, etc.
 *  - Execute commands
 *  - ** Subagent ** call itself via bash implements subagents.
 */
import OpenAI from 'openai';
import type { ChatCompletionMessageFunctionToolCall, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources';
import { $ } from 'bun';

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});

const systemPrompt = `You are a CLI agent at ${process.cwd()}. Solve problems using bash commands.` + 
`Rules:
- Prefer tools over prose. Act first, explain briefly after.
- Read files: cat, grep, find, rg, ls, head, tail
- Write files: echo '...' > file, sed -i, or cat << 'EOF' > file
- Subagent: For complex subtasks, spawn a subagent to keep context clean:
  bun v0_bash_agent.ts "explore src/ and summarize the architecture"

When to use subagent:
- Task requires reading many files (isolate the exploration)
- Task is independent and self-contained
- You want to avoid polluting current conversation with intermediate details

The subagent runs in isolation and returns only its final summary.
`;

const tools: ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'bash',
            description: `Execute shell command. Common patterns:
                - Read: cat/head/tail, grep/find/rg/ls, wc -l
                - Write: echo 'content' > file, sed -i 's/old/new/g' file
                - Subagent: bun v0_bash_agent.ts 'task description' (spawns isolated agent, returns summary)`,
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The bash command to execute' },
                },
                required: ['command'],
            },
        }
    },
];

async function executeCommand(command: string): Promise<string> {
    try {
        const result = await $`bash -c ${command}`.quiet();
        return result.stdout.toString() || result.stderr.toString() || '';
    } catch (error: any) {
        // Return error message as string for the agent to see
        return `Error: ${error.message}\n${error.stderr?.toString() || ''}`;
    }
}

async function chat(prompt: string, history: ChatCompletionMessageParam[] = []): Promise<ChatCompletionMessageParam[]> {
    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt },
    ];

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

            messages.push(assistantMessage);

            // Use finish_reason to determine next action
            if (finishReason === 'tool_calls') {
                // Model wants to call tools, process them
                if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                    // Process all tool calls
                    for (const toolCall of assistantMessage.tool_calls) {
                        const functionToolCall = toolCall as ChatCompletionMessageFunctionToolCall;
                        if (functionToolCall.function.name === 'bash') {
                            // Parse the JSON arguments
                            const args = JSON.parse(functionToolCall.function.arguments);
                            const command = args.command;
                            
                            console.log(`\n🔧 Executing: ${command}\n`);
                            const result = await executeCommand(command);
                            console.log(result);
                            
                            messages.push({
                                role: 'tool',
                                content: result,
                                tool_call_id: functionToolCall.id,
                            });
                        }
                    }
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
    // Handle command-line arguments for subagent mode
    const args = process.argv.slice(2);
    
    if (args.length > 0) {
        // Subagent mode: execute the task and return summary
        const task = args.join(' ');
        console.log(`\n🤖 Subagent task: ${task}\n`);
        const messages = await chat(task);
        
        // Extract the final assistant message
        const finalMessage = messages[messages.length - 1];
        if (finalMessage && finalMessage.role === 'assistant' && finalMessage.content) {
            console.log('\n📋 Summary:');
            console.log(finalMessage.content);
        }
    } else {
        // Interactive mode: prompt user for input
        const inquirer = (await import('inquirer')).default;
        const { prompt } = await inquirer.prompt([
            {
                type: 'input',
                name: 'prompt',
                message: 'What would you like me to do?',
            },
        ]);
        
        await chat(prompt);
    }
}

main().catch(console.error);