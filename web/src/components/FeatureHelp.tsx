import type { ReactNode } from 'react'

function Title({ children }: { children: ReactNode }) {
  return <h4 className="mb-1.5 text-sm font-semibold text-gray-100">{children}</h4>
}

function Heading({ children }: { children: ReactNode }) {
  return <h5 className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{children}</h5>
}

function Code({ children }: { children: string }) {
  return (
    <pre className="mt-1 overflow-x-auto whitespace-pre rounded-lg border border-gray-700/40 bg-gray-950/70 p-2.5 font-mono text-[11px] leading-snug text-gray-300">
      {children}
    </pre>
  )
}

function Inline({ children }: { children: ReactNode }) {
  return <code className="rounded bg-gray-800 px-1 font-mono text-[11px] text-emerald-300">{children}</code>
}

const FLOW_SCRIPT_EXAMPLE = `---
name: pr-review
schedule: "0 9 * * 1-5"
agent_profile: developer
script: ./check-prs.sh
---
There are [[count]] open PRs. Review them and
write a summary to ~/reports/pr-review.md.`

export function FlowsHelp() {
  return (
    <div>
      <Title>What is a flow?</Title>
      <p>
        A flow runs one agent with one prompt on a schedule. The server checks for due flows once a
        minute, so <Inline>cao-server</Inline> must be running.
      </p>
      <p className="mt-1.5">
        Each run starts a new session named <Inline>cao-flow-&lt;name&gt;</Inline> and closes the
        previous run's session. If the previous run is still working, the new run is skipped. Tell
        the agent to save its results to a file, because the session doesn't last.
      </p>

      <Heading>Example</Heading>
      <p>Create Flow with:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        <li>Name: <Inline>daily-pr-summary</Inline></li>
        <li>Schedule: Weekdays at 9 AM</li>
        <li>Profile: <Inline>developer</Inline></li>
        <li>Prompt: "List the open PRs in myorg/myrepo, summarize each in one line, and write the summary to ~/reports/prs.md."</li>
      </ul>
      <p className="mt-1.5">
        Every weekday at 09:00 a developer agent starts with that prompt. <b>Run Now</b> runs it once
        right away. The switch pauses the schedule.
      </p>

      <Heading>Run only when needed (CLI)</Heading>
      <p>
        A flow file can name a script. The script prints <Inline>{'{"execute": false, "output": {}}'}</Inline> to
        skip the run, or <Inline>{'{"execute": true, "output": {"count": "3"}}'}</Inline> to run it
        with <Inline>[[count]]</Inline> filled in.
      </p>
      <Code>{FLOW_SCRIPT_EXAMPLE}</Code>
      <p className="mt-1">Register it with <Inline>cao schedule add pr-review.md</Inline>.</p>

      <Heading>Good to know</Heading>
      <p>
        The prompt is read from the flow file on every run, so editing the prompt there changes the
        next run. Expand a flow to see its file path. Schedule, profile and provider are saved when
        the flow is added; to change them, delete the flow and add it again. A flow is one agent and one prompt; for several
        steps that pass results along, use a Workflow.
      </p>
    </div>
  )
}

const WORKFLOW_EXAMPLE = `from cao_workflow import run_step, emit_output

notes = run_step("claude_code", "researcher",
    "Find this week's news about solar power. "
    "Return 5 bullets with links.",
    step_id="research")

brief = run_step("claude_code", "writer",
    f"Write a one-page briefing from: {notes.output}",
    step_id="write")

emit_output({"briefing": brief.output})`

const WORKFLOW_COMMANDS = `cao workflow validate <file>.py
cao workflow run <name> --run-id brief-1
cao workflow status brief-1
cao workflow resume brief-1`

export function WorkflowsHelp() {
  return (
    <div>
      <Title>What is a workflow?</Title>
      <p>
        A workflow is a saved list of agent steps that you start yourself. Each step runs one agent
        profile with a prompt and returns its answer. Later steps can use earlier answers, and steps
        can run in parallel. Every step is saved, so a stopped run can be resumed without redoing
        the finished steps.
      </p>
      <p className="mt-1.5">
        A profile describes one agent: its role, tools and provider. A workflow is the plan that
        says which profile does each step.
      </p>

      <Heading>Example: a weekly briefing</Heading>
      <Code>{WORKFLOW_EXAMPLE}</Code>
      <p className="mt-1">
        A researcher gathers notes, then a writer turns them into a briefing.{' '}
        <Inline>researcher</Inline> and <Inline>writer</Inline> are profiles you would create.
        Workflows suit any repeated multi-step job, such as summarizing a folder of documents or
        translating and then checking a text.
      </p>

      <Heading>Run it</Heading>
      <p>
        <b>Add Script</b> creates a Python workflow and <b>New Workflow</b> creates a YAML one.{' '}
        <b>Run</b> asks for inputs and starts a run. From a terminal:
      </p>
      <Code>{WORKFLOW_COMMANDS}</Code>

      <Heading>Compared with n8n</Heading>
      <p>
        The idea is similar: steps, data passed between them, and a saved history of runs. Here
        each step is an AI agent instead of a fixed action, workflows are written as Python or YAML
        instead of drawn on a canvas, and there is no built-in trigger. For a timer, use a Flow
        for a single prompt, or run <Inline>cao workflow run</Inline> from cron.
      </p>
    </div>
  )
}
