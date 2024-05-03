import { flatten } from 'lodash'
import { RunnableSequence, RunnablePassthrough, RunnableConfig } from '@langchain/core/runnables'
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts'
import { ChatOpenAI } from '@langchain/openai'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { HumanMessage } from '@langchain/core/messages'
import { OllamaFunctions } from 'langchain/experimental/chat_models/ollama_functions'
import { formatToOpenAIToolMessages } from 'langchain/agents/format_scratchpad/openai_tools'
import { OpenAIToolsAgentOutputParser, type ToolsAgentStep } from 'langchain/agents/openai/output_parser'
import { INode, INodeData, INodeParams, IMultiAgentNode, ITeamState } from '../../../src/Interface'
import { AgentExecutor } from '../../../src/agents'

const examplePrompt = 'You are a research assistant who can search for up-to-date info using search engine.'

class Worker_MultiAgents implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs?: INodeParams[]
    badge?: string

    constructor() {
        this.label = 'Worker'
        this.name = 'worker'
        this.version = 1.0
        this.type = 'Worker'
        this.icon = 'worker.svg'
        this.category = 'Multi Agents'
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Worker Name',
                name: 'workerName',
                type: 'string',
                placeholder: 'My Worker'
            },
            {
                label: 'Worker Prompt',
                name: 'workerPrompt',
                type: 'string',
                rows: 4,
                default: examplePrompt
            },
            {
                label: 'Supervisor',
                name: 'supervisor',
                type: 'Supervisor'
            },
            {
                label: 'Tools',
                name: 'tools',
                type: 'Tool',
                list: true,
                optional: true
            },
            {
                label: 'Max Iterations',
                name: 'maxIterations',
                type: 'number',
                optional: true,
                additionalParams: true
            }
        ]
    }

    async init(nodeData: INodeData): Promise<any> {
        let tools = nodeData.inputs?.tools
        tools = flatten(tools)
        const workerPrompt = nodeData.inputs?.workerPrompt as string
        const workerName = nodeData.inputs?.workerName as string
        const supervisor = nodeData.inputs?.supervisor as IMultiAgentNode
        const maxIterations = nodeData.inputs?.maxIterations as string

        if (!workerName) throw new Error('Worker name is required!')

        const llm = supervisor.llm

        const agent = await createAgent(llm, [...tools], workerPrompt, maxIterations)

        const workerNode = async (state: ITeamState, config: RunnableConfig) =>
            await agentNode(
                {
                    state,
                    agent: agent,
                    name: workerName
                },
                config
            )

        const returnOutput: IMultiAgentNode = {
            node: workerNode,
            name: workerName,
            type: 'worker',
            parentSupervisorName: supervisor.name ?? 'supervisor'
        }

        return returnOutput
    }
}

async function createAgent(
    llm: ChatOpenAI | OllamaFunctions,
    tools: any[],
    systemPrompt: string,
    maxIterations?: string
): Promise<AgentExecutor> {
    const combinedPrompt =
        systemPrompt +
        '\nWork autonomously according to your specialty, using the tools available to you.' +
        ' Do not ask for clarification.' +
        ' Your other team members (and other teams) will collaborate with you with their own specialties.' +
        ' You are chosen for a reason! You are one of the following team members: {team_members}.'
    const toolNames = tools.length ? tools.map((t) => t.name).join(', ') : ''
    const prompt = ChatPromptTemplate.fromMessages([
        ['system', combinedPrompt],
        new MessagesPlaceholder('messages'),
        new MessagesPlaceholder('agent_scratchpad'),
        [
            'system',
            [
                'Supervisor instructions: {instructions}\n' + tools.length
                    ? `Remember, you individually can only use these tools: ${toolNames}`
                    : '' + '\n\nEnd if you have already completed the requested task. Communicate the work completed.'
            ].join('\n')
        ]
    ])

    const modelWithTools = tools.length ? llm.bind({ tools: tools.map(convertToOpenAITool) }) : llm.bind({ tools: undefined })

    const agent = RunnableSequence.from([
        //@ts-ignore
        RunnablePassthrough.assign({ agent_scratchpad: (input: { steps: ToolsAgentStep[] }) => formatToOpenAIToolMessages(input.steps) }),
        prompt,
        modelWithTools,
        new OpenAIToolsAgentOutputParser()
    ])
    const executor = AgentExecutor.fromAgentAndTools({
        agent: agent,
        tools,
        verbose: process.env.DEBUG === 'true' ? true : false,
        maxIterations: maxIterations ? parseFloat(maxIterations) : undefined
    })
    return executor
}

async function agentNode({ state, agent, name }: { state: any; agent: AgentExecutor; name: string }, config: RunnableConfig) {
    const result = await agent.invoke(state, config)
    return {
        messages: [new HumanMessage({ content: result.output, name })]
    }
}

module.exports = { nodeClass: Worker_MultiAgents }
