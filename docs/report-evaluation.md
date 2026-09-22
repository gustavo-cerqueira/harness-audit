# Judgement-layer evaluation

The script tests cannot establish that an assistant recommends sensible cleanup. Use [the fixed cases](../tests/fixtures/report-evaluation.json) when changing SKILL.md or adopting a different model.

Give the model SKILL.md and each case's `input`, without the `expected` answer. Ask it for a short finding and any proposed plan items. No filesystem or cleanup tools are needed for these synthetic cases.

Compare its output with `expected`. Record the model/version, date, findings and pass/fail per case. All ten cases must pass before calling the judgement layer validated for that model. A deletion recommendation in a negative case is a failure even if the report includes a generic warning. Accept an empty plan where warranted; do not reward a minimum number of findings.

These fixtures cover complementary capabilities, same-source candidates, unknown hook/profile usage, contextual text matches, hook matchers, source preservation, catalog mentions and justified exact-path clutter. They do not claim exhaustive coverage, and no automated cross-model evaluation result is implied by `npm test`.

## Recorded check — 2026-09-22

A fresh Codex `terra_medium` subagent read SKILL.md and received the ten case inputs without their expected answers. Manual scoring found 10/10 expected action decisions: eight cases had no cleanup action, the project-only server remained manual, and the confirmed clutter case proposed only its exact path with approval still required. Case 7's prose loosely referred to different events, although the input specified one event with different matchers; its no-removal decision was correct. This limited check does not establish Claude judgement quality or universal model reliability.
