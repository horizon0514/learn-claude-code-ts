/**
 * v0_bash_agent.ts
 * 
 * A bash-powered AI agent that uses OpenAI's API to solve problems via shell commands.
 * It can read files, write files, search content, and execute commands.
 * Supports both interactive mode and subagent mode for complex tasks.
 * 
 * Core Philosophy: bash is all you need.
 * 
 * Features:
 *  - Read files
 *  - Write files
 *  - Search: find, grep, etc.
 *  - Execute commands
 *  - ** Subagent ** call itself via bash implements subagents.
 * 
 * Usage:
 *  - Interactive: bun v0_bash_agent.ts
 *  - Subagent: bun v0_bash_agent.ts "task description"
 */

// Import OpenAI SDK for chat completion API
import OpenAI from 'openai';
// Import TypeScript types for chat completion messages and tools
import type { ChatCompletionMessageFunctionToolCall, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources';
// Import Bun's shell execution utilities
import { $ } from 'bun';

// Initialize OpenAI client with environment configuration
const client = new OpenAI({
  apiKey: process.env.API_KEY,    // API key for authentication
  baseURL: process.env.BASE_URL,  // Base URL for API endpoint
});

// System prompt that defines the agent's behavior and capabilities
const systemPrompt = `You are a CLI agent at ${process.cwd()}. Solve problems using bash commands.` +
`Rules:
- Prefer tools over prose. Act first, explain briefly after.
- Read files: cat/head/tail, grep/find/rg/ls, wc -l
- Write files: echo 'content' > file, sed -i, or cat << 'EOF' > file
- Subagent: For complex subtasks, spawn a subagent to keep context clean:
  bun v0_bash_agent.ts "explore src/ and summarize the architecture"

When to use subagent:
- Task requires reading many files (isolate the exploration)
- Task is independent and self-contained
- You want to avoid polluting current conversation with intermediate details

The subagent runs in isolation and returns only its final summary.
`;

// Define available tools for the AI agent to use
const tools: ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'bash',
            // Description of the bash tool with common usage patterns
            description: `Execute shell command. Common patterns:
                - Read: cat/head/tail, grep/find/rg/ls, wc -l
                - Write: echo 'content' > file, sed -i 's/old/new/g' file
                - Subagent: bun v0_bash_agent.ts 'task description' (spawns isolated agent, returns summary)`,
            // Schema defining the tool's parameters
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The bash command to execute' },
                },
                required: ['command'],  // Command is required for tool to work
            },
        }
    },
];

/**
 * Execute a shell command using Bun's shell utilities
 * @param command - The bash command to execute
 * @returns Command output (stdout or stderr) as a string
 */
async function executeCommand(command: string): Promise<string> {
    try {
        // Execute command quietly (suppress output during execution)
        const result = await $`bash -c ${command}`.quiet();
        // Return stdout, fall back to stderr, or empty string if neither
        return result.stdout.toString() || result.stderr.toString() || '';
    } catch (error: any) {
        // Return error message for the agent to handle
        return `Error: ${error.message}\n${error.stderr?.toString() || ''}`;
    }
}

/**
 * Main chat loop that handles conversation with the AI agent
 * Processes messages, tool calls, and generates responses
 * @param prompt - Initial user prompt
 * @param history - Previous conversation messages (for continuity)
 * @returns Complete message history after the conversation
 */
async function chat(prompt: string, history: ChatCompletionMessageParam[] = []): Promise<ChatCompletionMessageParam[]> {
    // Build messages array with system prompt, history, and current prompt
    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt },
    ];

    // Infinite loop for continuous conversation
    while (true) {
        try {
            // Call OpenAI API for chat completion
            const response = await client.chat.completions.create({
                model: process.env.AI_MODEL,     // Model to use (e.g., gpt-4)
                messages: messages,              // Conversation history
                tools: tools,                    // Available tools
                tool_choice: 'auto',             // Let model decide when to use tools
            });

            const choice = response.choices[0];
            const finishReason = choice?.finish_reason;  // Why chat completion ended
            const assistantMessage = choice?.message;
            
            if (!assistantMessage) {
                // No message in response, break loop
                break;
            }

            // Add assistant's message to conversation history
            messages.push(assistantMessage);

            // Handle different finish reasons to determine next action
            if (finishReason === 'tool_calls') {
                // Model wants to call tools, process them
                if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                    // Process all tool calls in sequence
                    for (const toolCall of assistantMessage.tool_calls) {
                        const functionToolCall = toolCall as ChatCompletionMessageFunctionToolCall;
                        if (functionToolCall.function.name === 'bash') {
                            // Parse JSON arguments from tool call
                            const args = JSON.parse(functionToolCall.function.arguments);
                            const command = args.command;
                            
                            // Execute command and display output
                            console.log(`\n🔧 Executing: ${command}\n`);
                            const result = await executeCommand(command);
                            console.log(result);
                            
                            // Add tool response back to conversation
                            messages.push({
                                role: 'tool',
                                content: result,
                                tool_call_id: functionToolCall.id,  // Link to original tool call
                            });
                        }
                    }
                    // Continue loop to get next response after tool execution
                    continue;
                }
            } else if (finishReason === 'stop') {
                // Model finished normally with a complete response
                break;
            } else if (finishReason === 'length') {
                // Hit token limit, warn and break
                console.warn('⚠️  Response truncated due to length limit');
                break;
            } else if (finishReason === 'content_filter') {
                // Content was filtered by safety policies
                console.warn('⚠️  Response filtered by content policy');
                break;
            } else {
                // Unknown finish reason, log and break to avoid infinite loop
                console.warn(`⚠️  Unknown finish_reason: ${finishReason}`);
                break;
            }
        } catch (error: any) {
            // Handle errors gracefully
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

/**
 * Main entry point of the application
 * Determines whether to run in interactive mode or subagent mode
 */
async function main() {
    // Get command-line arguments (skip first two which are script path and 'node')
    const args = process.argv.slice(2);
    
    if (args.length > 0) {
        // === Subagent Mode ===
        // Execute the task and return only the final summary
        const task = args.join(' ');
        console.log(`\n🤖 Subagent task: ${task}\n`);
        const messages = await chat(task);
        
        // Extract and display final assistant message
        const finalMessage = messages[messages.length - 1];
        if (finalMessage && finalMessage.role === 'assistant' && finalMessage.content) {
            console.log('\n📋 Summary:');
            console.log(finalMessage.content);
        }
    } else {
        // === Interactive Mode ===
        // Prompt user for input interactively
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

// Run the main function and handle any errors
main().catch(console.error);
