# Failure classification and gateway errors

The router decides whether to try another configured channel from the raw error text, not only from Pi's error category. This document records the rule for one provider response and what it does—and does not—mean.

## Reported response

The response reported by the user was:

> 当前请求未成功。 原因：请求处理过程中出现未归类错误。 解决方案：请稍后重试；如果问题持续，请带 request_id 联系客服排查。
> request_id: 202611211239031829861288268d9d6npAmIEqM

The router classifies the paired phrases `当前请求未成功` and `未归类错误` as `upstream_unclassified`. The request ID is not part of the matching rule, so every occurrence can be recognized. The exact phrase pair is required; generic Chinese text such as `请稍后重试` alone is insufficient.

## Routing behavior

`upstream_unclassified` is rotatable and uses the transient channel cooldown: two minutes for the first consecutive failure, doubling up to thirty minutes. It is also annotated for Pi's native retry path. If Pi terminates the run without retrying, the router's existing terminal takeover path uses the same classification to advance to another eligible channel.

The existing recovery budget remains in force: at most four complete passes per failure episode (the initial pass plus three repeats). If no eligible candidate remains or the budget is exhausted, the router stops and preserves the provider error.

## Safety boundary

The error text says the provider could not classify a request-processing failure; it does not prove by itself that the failure is channel-owned in every context. Accordingly, the rule matches only the paired provider-envelope phrases, not broad advice like “retry later.” The classifier's request-shaped checks run before provider rules, so recognized context-length, malformed-request, and missing-field failures still do not rotate, even if the envelope is also present.

The rule is deliberately last among provider classifications. More specific transport, quota, authentication, timeout, moderation, or provider-unavailable matches retain their existing kinds and cooldowns. A prompt which matches neither this envelope nor another known rule remains `unknown` and does not rotate.

## English upstream request failure

The later session reported this response:

> Error: upstream error: do request failed (request id: 20261121143209442001439RP9kQHsq)

The session evidence showed this assistant failure on `subrouter-lingai/deepseek-v4.1-flash-1017`, selected through `router/deepseek-rapido`, with zero output tokens and about 24 seconds of duration. The decision log contained no `failure recorded`, `taking over`, or `not recovering` entry for that turn. Before this rule, the classifier returned `unknown`, so the chain did not advance. The same envelope also appeared in an earlier session through another provider, supporting treatment as a transient upstream/channel failure rather than a request-specific defect.

The paired phrases `upstream error` and `do request failed` are classified as `upstream_request_failed`. The request ID is ignored. This kind is rotatable, receives the normal transient cooldown, is annotated for Pi's native retry path, and uses the existing terminal takeover when Pi abandons the run. The rule does not match `do request failed` or `upstream error` by itself.

As with the Chinese envelope, request-shaped checks run first and more specific transport, authentication, quota, timeout, or provider-unavailable rules retain their own classifications when present.

## Implementation and verification

- Classifier rules and rotatable kinds: `lib/classify.js`.
- Classification examples and safety-boundary tests: `test/classify.test.js`, for both envelopes.
- Retry annotation and terminal-takeover coverage: `test/router.test.js`.
- Run the extension suite from this directory with `npm test`.

These behaviors are based on user-reported responses, the local session/log evidence described above, and local automated tests; no live provider request or independent provider diagnosis was performed.
