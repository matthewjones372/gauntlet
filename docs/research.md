# Research

Back to the [README](../README.md).

The concern isn't that agents are malicious. It's that an agent optimising
against a verification signal will find the weaknesses in that signal. The
research below documents that in agentic and coding settings.

- **Reward hacking escalates from the score to the environment.** A 2026 survey
  of reward hacking in agentic LLM systems [1] describes levels that escalate
  from exploiting features of a reward, to gaming the evaluator or verifier, to
  manipulating the environment that produces the result. It lists test
  modification as an environment-level hack, and argues for layered defences
  across verification, isolation and monitoring rather than a single fix.
- **For coding agents, verification is now the hard part.** *The Verification
  Horizon* [2] argues that generating candidate solutions has become easier
  than verifying them, that every verifier (tests included) is only a proxy for
  intent, and that no fixed reward stays effective as agents get more capable.
- **Agents edit tests more, and differently.** A study of over 1.2 million
  commits [3] found that agent commits touched test files more often than other
  commits (23% against 13%) and added mocks more often (36% against 26%), which
  the authors note may make those tests less effective at checking real
  behaviour.
- **Models can game their own checks.** A preprint on specification gaming in
  generated code [4] documents code that passes its own assertions while missing
  what the test was meant to establish, for example by dropping the branch that
  could falsify it. In its experiments, counter-tests run by a separate party the
  generator couldn't influence caught every case, while LLM judges were
  sometimes fooled.
- **Detecting a hack after the fact is unreliable.** On a benchmark of reward
  hacks in code environments [5], the best model spotted 63% of hacks when it
  could compare against a benign trajectory, and 45% when judging one alone.

## References

1. Morampudi, A., Irrinki, U., Grandhi, R., Pagadala, V. and Maddula, M.
   *A survey of reward hacking in agentic large language model systems.*
   Discover Artificial Intelligence 6 (2026).
   [doi:10.1007/s44163-026-01980-z](https://doi.org/10.1007/s44163-026-01980-z)
2. Wang, B., Zhang, C., Liu, D. et al. *The Verification Horizon: No Silver
   Bullet for Coding Agent Rewards.* 2026.
   [arXiv:2606.26300](https://arxiv.org/abs/2606.26300)
3. Hora, A. and Robbes, R. *Are Coding Agents Generating Over-Mocked Tests? An
   Empirical Study.* MSR 2026.
   [arXiv:2602.00409](https://arxiv.org/abs/2602.00409)
4. Alami, D. *Specification gaming in LLM-generated code: detecting cognitive
   camouflage by adversarial execution.* 2026, preprint (not peer reviewed).
   [SSRN 6512960](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6512960)
5. Deshpande, D., Kannappan, A. and Qian, R. *Benchmarking Reward Hack Detection
   in Code Environments via Contrastive Analysis.* ICML 2026.
   [arXiv:2601.20103](https://arxiv.org/abs/2601.20103)

These papers motivate the problem Gauntlet addresses. None of them evaluates
Gauntlet, and their findings come from their own settings (training rewards,
benchmarks, mined commits, debate logs), not from Gauntlet's.
