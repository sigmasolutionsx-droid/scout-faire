import React, { useState } from 'react';
import { Play, Settings, Terminal, FileText, Globe, Code, AlertCircle, CheckCircle, Loader } from 'lucide-react';

const MarketingAgent = () => {
  const [apiKey, setApiKey] = useState('');
  const [task, setTask] = useState('');
  const [logs, setLogs] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [reasoningMode, setReasoningMode] = useState('high');
  const [config, setConfig] = useState({
    maxIterations: 10,
    autoExecute: true,
    verifyWork: true
  });

  const SYSTEM_PROMPT = `You are an autonomous AI Marketing Agent, not a chatbot. You are a WORKER with agency.

OPERATIONAL PRINCIPLES:
1. ACT, DON'T ASK - Execute tasks autonomously without seeking permission
2. VERIFY YOUR WORK - Always validate results before marking complete
3. ITERATE UNTIL COMPLETE - Use the agentic loop to refine and improve
4. USE YOUR TOOLS - You have hands to interact with the world
5. THINK THEN ACT - Plan your approach but execute decisively

AVAILABLE TOOLS:
- web_search: Search for market research, competitor analysis, trends
- web_fetch: Extract content from websites for analysis
- write_file: Create marketing content, reports, campaigns
- read_file: Analyze existing content and data
- execute_code: Run Python for data analysis, visualization

MARKETING CAPABILITIES:
- Market Research & Competitive Analysis
- Content Strategy & Creation
- SEO & Keyword Research
- Social Media Campaign Planning
- Email Marketing Sequences
- Ad Copy Generation & A/B Testing
- Customer Persona Development
- Analytics & Performance Reporting

WORKFLOW:
1. Analyze the task and break it into actionable steps
2. Execute each step using appropriate tools
3. Verify results meet quality standards
4. Iterate if needed to improve output
5. Deliver final deliverables

OUTPUT FORMAT:
Always structure responses as:
- ANALYSIS: What you understand about the task
- PLAN: Steps you will execute
- EXECUTION: Actions taken with tool calls
- RESULTS: Deliverables and outcomes
- VERIFICATION: Quality checks performed

You operate autonomously. Make decisions. Execute. Deliver results.`;

  const TOOLS = [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for marketing research, trends, competitors",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch content from a specific URL for analysis",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" }
          },
          required: ["url"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write marketing content to a file",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Name of file" },
            content: { type: "string", description: "File content" }
          },
          required: ["filename", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "execute_python",
        description: "Execute Python code for data analysis or visualization",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: "Python code to execute" }
          },
          required: ["code"]
        }
      }
    }
  ];

  const addLog = (type, message, data = null) => {
    setLogs(prev => [...prev, {
      timestamp: new Date().toISOString(),
      type,
      message,
      data
    }]);
  };

  const simulateToolExecution = async (toolName, args) => {
    await new Promise(resolve => setTimeout(resolve, 800));
    
    switch(toolName) {
      case 'web_search':
        return {
          results: [
            "Found 3 competitor analysis reports",
            "Identified 5 trending keywords in your niche",
            "Located 8 relevant market research articles"
          ]
        };
      case 'web_fetch':
        return {
          content: "Sample webpage content with competitive intelligence...",
          word_count: 1250
        };
      case 'write_file':
        return {
          success: true,
          file: args.filename,
          size: args.content.length
        };
      case 'execute_python':
        return {
          success: true,
          output: "Analysis complete. Generated 3 charts and 1 report."
        };
      default:
        return { success: true };
    }
  };

  const executeAgenticLoop = async (taskDescription) => {
    if (!apiKey) {
      addLog('error', 'API key required');
      return;
    }

    setIsRunning(true);
    setLogs([]);
    addLog('info', 'Initializing AI Marketing Agent...');
    addLog('info', `Model: GPT-OSS 120B | Reasoning: ${reasoningMode} | Max Iterations: ${config.maxIterations}`);

    const conversationHistory = [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: taskDescription
      }
    ];

    let iteration = 0;
    let taskComplete = false;

    try {
      while (iteration < config.maxIterations && !taskComplete) {
        iteration++;
        addLog('iteration', `Agentic Loop - Iteration ${iteration}`);

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-oss-120b",
            messages: conversationHistory,
            tools: TOOLS,
            tool_choice: "auto",
            max_tokens: 4000,
            temperature: 0.7,
            reasoning_effort: reasoningMode
          })
        });

        if (!response.ok) {
          throw new Error(`Groq API error: ${response.status}`);
        }

        const data = await response.json();
        const assistantMessage = data.choices[0].message;
        
        conversationHistory.push(assistantMessage);

        if (assistantMessage.content) {
          addLog('agent', assistantMessage.content);
        }

        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          for (const toolCall of assistantMessage.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);
            
            addLog('tool', `Executing: ${toolName}`, toolArgs);

            const toolResult = await simulateToolExecution(toolName, toolArgs);
            
            addLog('success', `${toolName} completed`, toolResult);

            conversationHistory.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolName,
              content: JSON.stringify(toolResult)
            });
          }
        } else if (assistantMessage.content && 
                   (assistantMessage.content.toLowerCase().includes('complete') ||
                    assistantMessage.content.toLowerCase().includes('finished') ||
                    assistantMessage.content.toLowerCase().includes('delivered'))) {
          taskComplete = true;
          addLog('success', 'Task marked as complete by agent');
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (iteration >= config.maxIterations) {
        addLog('warning', 'Max iterations reached. Task may be incomplete.');
      }

    } catch (error) {
      addLog('error', `Error: ${error.message}`);
    } finally {
      setIsRunning(false);
      addLog('info', 'Agent execution completed');
    }
  };

  const LogEntry = ({ log }) => {
    const icons = {
      info: <Terminal className="w-4 h-4 text-blue-500" />,
      agent: <Globe className="w-4 h-4 text-purple-500" />,
      tool: <Code className="w-4 h-4 text-orange-500" />,
      success: <CheckCircle className="w-4 h-4 text-green-500" />,
      error: <AlertCircle className="w-4 h-4 text-red-500" />,
      warning: <AlertCircle className="w-4 h-4 text-yellow-500" />,
      iteration: <Loader className="w-4 h-4 text-indigo-500" />
    };

    return (
      <div className="mb-3 p-3 bg-gray-800 rounded border-l-4" 
           style={{borderLeftColor: log.type === 'error' ? '#ef4444' : 
                                   log.type === 'success' ? '#10b981' : 
                                   log.type === 'agent' ? '#a855f7' : '#3b82f6'}}>
        <div className="flex items-start gap-2">
          {icons[log.type]}
          <div className="flex-1">
            <div className="text-xs text-gray-400 mb-1">
              {new Date(log.timestamp).toLocaleTimeString()}
            </div>
            <div className="text-sm text-gray-100 whitespace-pre-wrap">
              {log.message}
            </div>
            {log.data && (
              <pre className="mt-2 text-xs bg-gray-900 p-2 rounded overflow-x-auto text-gray-300">
                {JSON.stringify(log.data, null, 2)}
              </pre>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Globe className="w-8 h-8 text-purple-500" />
            <h1 className="text-3xl font-bold bg-gradient-to-r from-purple-400 to-pink-500 bg-clip-text text-transparent">
              AI Marketing Agent
            </h1>
          </div>
          <p className="text-gray-400">Autonomous Worker powered by GPT-OSS 120B via Groq</p>
        </div>

        {/* Configuration Panel */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
            <div className="flex items-center gap-2 mb-4">
              <Settings className="w-5 h-5 text-purple-500" />
              <h2 className="text-lg font-semibold">Configuration</h2>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">Groq API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="gsk_..."
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Reasoning Mode</label>
                <select
                  value={reasoningMode}
                  onChange={(e) => setReasoningMode(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                >
                  <option value="low">Low (Fast)</option>
                  <option value="medium">Medium (Balanced)</option>
                  <option value="high">High (Quality)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Max Iterations</label>
                <input
                  type="number"
                  value={config.maxIterations}
                  onChange={(e) => setConfig({...config, maxIterations: parseInt(e.target.value)})}
                  min="1"
                  max="20"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
            <div className="flex items-center gap-2 mb-4">
              <FileText className="w-5 h-5 text-purple-500" />
              <h2 className="text-lg font-semibold">Marketing Task</h2>
            </div>
            
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Example: Analyze our top 3 competitors in the SaaS space, create a competitive positioning document, and generate 5 blog post ideas that differentiate us from them."
              className="w-full h-32 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500 resize-none"
            />

            <button
              onClick={() => executeAgenticLoop(task)}
              disabled={isRunning || !task || !apiKey}
              className="w-full mt-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed rounded py-2 px-4 font-semibold flex items-center justify-center gap-2 transition-all"
            >
              {isRunning ? (
                <>
                  <Loader className="w-5 h-5 animate-spin" />
                  Agent Running...
                </>
              ) : (
                <>
                  <Play className="w-5 h-5" />
                  Execute Task
                </>
              )}
            </button>
          </div>
        </div>

        {/* Agent Logs */}
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <div className="flex items-center gap-2 mb-4">
            <Terminal className="w-5 h-5 text-purple-500" />
            <h2 className="text-lg font-semibold">Agent Execution Log</h2>
            {logs.length > 0 && (
              <span className="ml-auto text-sm text-gray-400">{logs.length} events</span>
            )}
          </div>

          <div className="bg-gray-900 rounded p-4 max-h-96 overflow-y-auto">
            {logs.length === 0 ? (
              <div className="text-center text-gray-500 py-8">
                No activity yet. Configure your agent and execute a task.
              </div>
            ) : (
              logs.map((log, idx) => <LogEntry key={idx} log={log} />)
            )}
          </div>
        </div>

        {/* Info Panel */}
        <div className="mt-6 bg-gradient-to-r from-purple-900/30 to-pink-900/30 rounded-lg p-4 border border-purple-500/30">
          <h3 className="font-semibold mb-2 text-purple-300">Agentic Architecture</h3>
          <p className="text-sm text-gray-300">
            This agent uses the GPT-OSS 120B MoE model (120B total, 5.1B active) with autonomous tool use. 
            It operates in an agentic loop: plan → execute → verify → iterate until task completion.
            No hand-holding. Pure execution.
          </p>
        </div>
      </div>
    </div>
  );
};

export default MarketingAgent;