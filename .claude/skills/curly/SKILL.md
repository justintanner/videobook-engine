---
name: curly
description: Launch the curly agent to review code for FP violations in the background
disable-model-invocation: true
allowed-tools: Task
---

Launch the **curly** agent in the background using the Task tool with `subagent_type: "curly"` and `run_in_background: true`. Do not send any other text or messages besides this tool call.
