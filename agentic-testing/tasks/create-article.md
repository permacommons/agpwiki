# Task: create an article

Default agentic-testing task. Sends an autonomous agent through
the full create-an-encyclopedia-article workflow against the local
agpwiki MCP. The agent picks up the prompt below, follows whatever
guidance the server provides, and ends with a structured
retrospective the operator mines for tool-ergonomics issues.

The launcher reads everything below the `## Prompt` heading and
sends it as the user message. To swap topics, edit the **Topic**
line below — pick something with reasonably clear factual content
and at least a few authoritative published sources.

See `agentic-testing/README.md` for the full harness.

---

## Prompt

> Topic: **Dendrobium kingianum**
>
> _(Substitute any subject you like; pick something with clear
> factual content and authoritative published sources.)_

You are an autonomous agent contributing to the agpedia encyclopedia
via its MCP server. Your task: create a complete encyclopedic article
on the topic above.

Work end-to-end without asking for confirmation along the way. Follow
whatever guidance the server itself provides — its MCP instructions,
tool descriptions, and the wiki pages it points you at.

This session evaluates how well the server's own guidance orients an
agent on the core task of creating a good encyclopedia article. The
retrospective at the end is the load-bearing output: be candid about
anything that felt confusing, missing, or awkward.

### End with a retrospective

After the article exists and you're satisfied it's done, write a
final message with this structure (concise — one to three sentences
per item, or "none" if nothing's worth flagging):

```markdown
## Agentic test retrospective

### Topic
<topic and final article slug>

### Tool-call summary
<rough count + sequence — e.g., "5 wiki_readPage, 6 citation_create,
8 claim_create, 1 wiki_createPage, 2 wiki_updatePage">

### Server guidance — what worked
<which pieces of server-provided guidance (MCP instructions, tool
descriptions, /meta/* pages) actually helped you orient and proceed
without ambiguity>

### Server guidance — what was confusing, missing, or contradictory
<places where the server didn't tell you something you needed, where
instructions seemed to disagree, or where you had to guess>

### Tool friction
<concrete moments where you had to retry, where an error message
didn't tell you how to recover, or where a schema didn't match your
mental model>

### Missing affordances
<things the surface should have but doesn't>

### Workarounds adopted
<places where you did something non-obvious to make a tool work>

### Suggested improvements
<small, concrete tool/schema/error-message/policy-page changes that
would have saved you the most time on this run>
```

Be specific. Vague retrospectives are useless — the operator uses
this output to decide which tool ergonomics, error messages, and
policy-page wording to fix next.
