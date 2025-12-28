import React, { useState } from 'react';
import { Play, Settings, Terminal, FileText, Globe, Code, AlertCircle, CheckCircle, Loader, Key } from 'lucide-react';

const MarketingAgent = () => {
  const [groqApiKey, setGroqApiKey] = useState('');
  const [tavilyApiKey, setTavilyApiKey] = useState('');
  const [task, setTask] = useState('');
  const [logs, setLogs] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [reasoningMode, setReasoningMode] = useState('high');
  const [config, setConfig] = useState({
    maxIterations: 15,
    searchDepth: 'advanced',
    maxSearchResults: 5,
    requireVerification: true
  });

  const SYSTEM_PROMPT = `You are an autonomous AI Marketing Agent with real internet access. You are a WORKER, not a consultant.

OPERATIONAL PRINCIPLES:
1. ACT, DON'T ASK - Execute tasks autonomously. Make decisions.
2. REASON OVER SEARCH - Evaluate search quality. Re-search if results are insufficient.
3. VERIFY YOUR WORK - Always validate deliverables meet professional standards.
4. ITERATE UNTIL COMPLETE - Don't settle for mediocre output.
5. USE TOOLS STRATEGICALLY - Plan tool usage, don't just search randomly.

CRITICAL: REASONING-OVER-SEARCH WORKFLOW
After each search:
1. Evaluate result quality: Are these sources authoritative? Is the data current?
2. Assess information gaps: What's missing? Do I need different search queries?
3. Decide next action: Re-search with refined query, fetch full content, or proceed to execution?

Example bad agent behavior:
❌ Search "marketing trends" → immediately write generic blog post

Example good agent behavior:
✅ Search "marketing trends 2025" → Evaluate: "Results are too broad and include B2C when client is B2B SaaS"
✅ Re-search "B2B SaaS marketing trends 2025" → Evaluate: "Good sources but missing pricing data"
✅ Search "B2B SaaS pricing models 2025" → Evaluate: "Now I have specific, relevant data"
✅ Proceed to content creation with high-quality, specific information

AVAILABLE TOOLS:
- tavily_search: Real internet search with full content extraction
  * Use search_depth: "advanced" for detailed content
  * Returns cleaned, readable text from actual websites
  * Includes source URLs for citations
  
- write_file: Create marketing deliverables
  * Always include sources and citations
  * Professional formatting required
  
- execute_python: Data analysis, visualization, processing
  * Use for analyzing search results
  * Generate charts and reports

TASK COMPLETION CRITERIA:
Only mark a task complete when:
1. All deliverables are created and saved
2. Information quality is verified (authoritative sources, recent data)
3. Output meets professional marketing standards
4. No critical information gaps remain

When complete, respond with: "TASK_COMPLETE: [summary of deliverables]"

You have real internet access. Use it strategically. Reason about information quality. Deliver professional work.`;

  const TOOLS = [
    {
      type: "function",
      function: {
        name: "tavily_search",
        description: "Search the internet and retrieve full content from websites. Returns cleaned, readable text with sources.",
        parameters: {
          type: "object",
          properties: {
            query: { 
              type: "string", 
              description: "Specific search query. Be precise - generic queries yield generic results." 
            },
            search_depth: {
              type: "string",
              enum: ["basic", "advanced"],
              description: "Use 'advanced' for more comprehensive content extraction"
            }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write marketing content, reports, or analysis to a file",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Descriptive filename with extension" },
            content: { type: "string", description: "Complete file content with proper formatting" }
          },
          required: ["filename", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "execute_python",
        description: "Execute Python code for data analysis, processing, or visualization",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: "Python code to execute" },
            purpose: { type: "string", description: "What this code accomplishes" }
          },
          required: ["code", "purpose"]
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

  // REAL TAVILY SEARCH IMPLEMENTATION
  const executeTavilySearch = async (query, searchDepth = 'advanced') => {
    try {
      addLog('info', `Executing Tavily search: "${query}" (${searchDepth} mode)`);
      
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query: query,
          search_depth: searchDepth,
          max_results: config.maxSearchResults,
          include_answer: true,
          include_raw_content: false,
          include_images: false
        }),
      });

      if (!response.ok) {
        throw new Error(`Tavily API error: ${response.status}`);
      }

      const data = await response.json();
      
      // Format results for LLM consumption
      const formattedResults = {
        query: query,
        answer: data.answer || "No summary available",
        sources: data.results.map((r, idx) => ({
          index: idx + 1,
          title: r.title,
          url: r.url,
          content: r.content,
          score: r.score
        })),
        result_count: data.results.length
      };

      // Create readable text for the LLM
      const contextText = `
SEARCH QUERY: "${query}"

QUICK ANSWER: ${data.answer || "Not available"}

SOURCES (${data.results.length} results):

${data.results.map((r, idx) => `
[${idx + 1}] ${r.title}
URL: ${r.url}
Relevance Score: ${r.score}
Content:
${r.content}
---
`).join('\n')}`;

      addLog('success', `Retrieved ${data.results.length} sources`, {
        sources: data.results.map(r => ({ title: r.title, url: r.url }))
      });

      return {
        raw: formattedResults,
        text: contextText
      };
      
    } catch (error) {
      addLog('error', `Tavily search failed: ${error.message}`);
      return {
        raw: { error: error.message },
        text: `Error executing search: ${error.message}`
      };
    }
  };

  const executeWriteFile = async (filename, content) => {
    addLog('info', `Creating file: ${filename}`);
    
    // Simulate file creation (in real implementation, this would save to storage)
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const fileInfo = {
      filename,
      size: content.length,
      created: new Date().toISOString(),
      preview: content.substring(0, 200) + '...'
    };

    addLog('success', `File created: ${filename}`, fileInfo);
    
    return {
      success: true,
      file: fileInfo
    };
  };

  const executePython = async (code, purpose) => {
    addLog('info', `Executing Python: ${purpose}`);
    
    // Simulate Python execution
    await new Promise(resolve => setTimeout(resolve, 800));
    
    const result = {
      success: true,
      purpose,
      output: "Execution completed successfully",
      code_length: code.length
    };

    addLog('success', `Python execution complete: ${purpose}`);
    
    return result;
  };

  const executeAgenticLoop = async (taskDescription) => {
    if (!groqApiKey || !tavilyApiKey) {
      addLog('error', 'Both Groq and Tavily API keys required');
      return;
    }

    setIsRunning(true);
    setLogs([]);
    
    addLog('info', '🚀 Initializing Agentic Marketing Worker');
    addLog('info', `Model: GPT-OSS 120B | Reasoning: ${reasoningMode} | Search Depth: ${config.searchDepth}`);
    addLog('info', 'Agent has REAL internet access via Tavily');

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
        addLog('iteration', `🔄 Agentic Loop - Iteration ${iteration}/${config.maxIterations}`);

        // Call Groq API with GPT-OSS 120B
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${groqApiKey}`,
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
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Groq API error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
        }

        const data = await response.json();
        const assistantMessage = data.choices[0].message;
        
        // Log agent reasoning/thinking
        if (assistantMessage.content) {
          addLog('agent', assistantMessage.content);
          
          // Check for task completion signal
          if (assistantMessage.content.includes('TASK_COMPLETE')) {
            taskComplete = true;
            addLog('success', '✅ Agent marked task as complete');
          }
        }

        conversationHistory.push(assistantMessage);

        // Execute tools if requested
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          for (const toolCall of assistantMessage.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);
            
            addLog('tool', `🔧 Tool Call: ${toolName}`, toolArgs);

            let toolResult;

            // Execute real tools
            switch(toolName) {
              case 'tavily_search':
                const searchResult = await executeTavilySearch(
                  toolArgs.query, 
                  toolArgs.search_depth || config.searchDepth
                );
                toolResult = searchResult.text;
                break;
                
              case 'write_file':
                const fileResult = await executeWriteFile(
                  toolArgs.filename,
                  toolArgs.content
                );
                toolResult = JSON.stringify(fileResult);
                break;
                
              case 'execute_python':
                const pythonResult = await executePython(
                  toolArgs.code,
                  toolArgs.purpose
                );
                toolResult = JSON.stringify(pythonResult);
                break;
                
              default:
                toolResult = JSON.stringify({ error: "Unknown tool" });
            }

            // Add tool result to conversation
            conversationHistory.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolName,
              content: toolResult
            });
          }
        } else if (!taskComplete) {
          // Agent didn't call tools and didn't complete - might be stuck
          addLog('warning', 'Agent thinking without tool calls...');
        }

        // Small delay between iterations
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (iteration >= config.maxIterations && !taskComplete) {
        addLog('warning', '⚠️ Max iterations reached. Task may be incomplete.');
      } else if (taskComplete) {
        addLog('success', `✅ Task completed in ${iteration} iterations`);
      }

    } catch (error) {
      addLog('error', `❌ Critical Error: ${error.message}`);
      console.error('Agent error:', error);
    } finally {
      setIsRunning(false);
      addLog('info', '🏁 Agent execution finished');
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
            <span className="px-3 py-1 bg-green-500/20 text-green-400 text-xs rounded-full border border-green-500/30">
              REAL INTERNET ACCESS
            </span>
          </div>
          <p className="text-gray-400">Autonomous Worker • GPT-OSS 120B • Tavily Search</p>
        </div>

        {/* Configuration Panel */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
            <div className="flex items-center gap-2 mb-4">
              <Key className="w-5 h-5 text-purple-500" />
              <h2 className="text-lg font-semibold">API Keys</h2>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">Groq API Key</label>
                <input
                  type="password"
                  value={groqApiKey}
                  onChange={(e) => setGroqApiKey(e.target.value)}
                  placeholder="gsk_..."
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Tavily API Key</label>
                <input
                  type="password"
                  value={tavilyApiKey}
                  onChange={(e) => setTavilyApiKey(e.target.value)}
                  placeholder="tvly-..."
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                />
                <a 
                  href="https://tavily.com" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-xs text-purple-400 hover:text-purple-300 mt-1 inline-block"
                >
                  Get Tavily API Key →
                </a>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Reasoning Mode</label>
                <select
                  value={reasoningMode}
                  onChange={(e) => setReasoningMode(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                >
                  <option value="low">Low - Fast</option>
                  <option value="medium">Medium - Balanced</option>
                  <option value="high">High - Maximum Quality</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Search Depth</label>
                <select
                  value={config.searchDepth}
                  onChange={(e) => setConfig({...config, searchDepth: e.target.value})}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                >
                  <option value="basic">Basic</option>
                  <option value="advanced">Advanced (Recommended)</option>
                </select>
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
              placeholder="Example: Research the top 5 B2B SaaS marketing trends for 2025, analyze pricing strategies from 3 competitors (Salesforce, HubSpot, Marketo), and create a comprehensive positioning document with citations."
              className="w-full h-40 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500 resize-none"
            />

            <button
              onClick={() => executeAgenticLoop(task)}
              disabled={isRunning || !task || !groqApiKey || !tavilyApiKey}
              className="w-full mt-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed rounded py-3 px-4 font-semibold flex items-center justify-center gap-2 transition-all"
            >
              {isRunning ? (
                <>
                  <Loader className="w-5 h-5 animate-spin" />
                  Agent Working...
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

          <div className="bg-gray-900 rounded p-4 max-h-[500px] overflow-y-auto">
            {logs.length === 0 ? (
              <div className="text-center text-gray-500 py-8">
                <Globe className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>Ready to execute. Configure API keys and provide a task.</p>
              </div>
            ) : (
              logs.map((log, idx) => <LogEntry key={idx} log={log} />)
            )}
          </div>
        </div>

        {/* Architecture Info */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-gradient-to-r from-purple-900/30 to-pink-900/30 rounded-lg p-4 border border-purple-500/30">
            <h3 className="font-semibold mb-2 text-purple-300">🧠 Reasoning-Over-Search</h3>
            <p className="text-sm text-gray-300">
              Agent evaluates search quality after each query and decides whether to re-search with refined queries, 
              fetch additional sources, or proceed to execution. No blind searching.
            </p>
          </div>
          
          <div className="bg-gradient-to-r from-blue-900/30 to-cyan-900/30 rounded-lg p-4 border border-blue-500/30">
            <h3 className="font-semibold mb-2 text-blue-300">🌐 Real Internet Access</h3>
            <p className="text-sm text-gray-300">
              Tavily provides scraped, cleaned content from actual websites. No link lists - 
              the agent reads real text, analyzes it, and makes informed decisions.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MarketingAgent;