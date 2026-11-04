# Semantic commit recovery

Semantic mutations and their outbox entry commit in one SQL transaction.
The engine then stages each declared changed semantic table, creates one Dolt
revision carrying the operation ID, and removes the outbox entry in a second
SQL transaction. Reopening replays pending outbox entries before exposing the
catalog.

For a mutation that changes rows, recovery uses the remaining working diff to
finish the original commit. If that commit is already durable, no semantic
diff remains and recovery only clears the outbox. Provenance-only operations
intentionally create empty commits, so absence of a diff is ambiguous. During
recovery, the engine searches recorded operation IDs before creating another
empty commit. This includes an earlier committed operation followed by a later
successful write; checking only HEAD would duplicate the older entry.
After a failed semantic write, the next semantic write first recovers pending
outbox work. This preserves operation order and prevents a later mutation
from absorbing an earlier transaction's uncommitted history. Ordinary successful
writes do not add an outbox scan to their path.

`tests/semantic-crash.test.ts` launches separate Node processes against copies
of a closed fixture. It first records the actual boundary sequence for a
four-operation edit affecting clips and transforms and for a provenance-only
operation. It then sends the executing process SIGKILL at every observed
boundary, including every individual table-staging call. The callback writes
its boundary synchronously before termination; the parent checks both the
last boundary and the SIGKILL exit signal. A timeout cannot masquerade as a
successful boundary test.

The matrix covers:

- Semantic changes inside the SQL transaction, before outbox insertion.
- Outbox insertion before the semantic SQL commit, and immediately after it.
- Each table stage, before the Dolt commit, and immediately after it.
- Before outbox deletion, after deletion before its SQL commit, and after
  that commit.
- Repeated termination during recovery of an already committed SQL batch.
- A committed provenance operation left in the outbox while another operation
  succeeds, followed by process termination.

Before the semantic SQL commit, reopen must show the original state and no
new operation. After it, reopen must show all three clips, the transform and
exactly one corresponding history entry, or exactly one provenance entry.
The tests also verify the edit audit, empty outbox, no staged rows, subsequent
successful writes and repeated reopen. No graceful engine close runs in the
killed process. Existing exception-recovery tests remain useful for error
responses, but do not substitute for this matrix.

These tests verify application-visible transaction boundaries in the native
catalog on the executing platform. They do not simulate physical disk failure
or interrupt the interior of a native SQL statement. Migration publication
and consumer archive switching have separate process-interruption fixtures.
The optional `semanticCommitBoundary` callback is a diagnostic fault-injection
hook; normal consumers should omit it. `after-table-stage` may occur several
times for one operation, and recovery can invoke callbacks during engine open.

## One owning process

A catalog needs one owning process while it writes. A semantic write commits in
two steps, and an outbox entry does not record who owns it, so reopening cannot
tell a crashed writer from a live one between those steps. A second process that
opens the catalog replays the live writer's entry, and the two race for the Dolt
commit.

With one process writing in a loop and another opening the catalog:

- The open often throws. About four in five opens threw when they overlapped a
  stream of commits, and about one in six when both processes started together.
- The owner's write can return `IO_ERROR` with `nothing to commit, working tree
  clean` or `cannot commit: database is busy or branch HEAD changed`, even though
  the write committed. A second process that commits while the writer is between
  staging and its own Dolt commit causes this every time. Every write reported as
  failed was present afterwards with one commit of its own, so retrying one
  creates a duplicate.
- Nothing is lost. After every run the worktree was clean, the outbox was empty,
  each row had exactly one commit and a plain open succeeded.

Engine 5.7.1 behaves the same way. The rates depend on timing, so treat them as
indicative.

Consumers must keep a second process away from a catalog that is being written.
Videobook does this with a per-library server lock, taken before any catalog
opens. Its other commands relay to the lock holder, refuse to run, or do not open
a catalog. Sharing a catalog between live processes would need outbox entries that
record their owner, and a commit step that treats an operation someone else
already committed as a success.
