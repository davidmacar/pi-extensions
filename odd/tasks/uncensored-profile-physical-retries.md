# Uncensored profile and physical-model recovery
Branch: `feat/uncensored-profile-physical-retries`; delivery: local feature branch, no push or PR.
Scope: add the `uncensored` agent profile and bounded recovery for directly selected physical models; preserve virtual failover behavior.

## Specs
S1: "Quiero que crear un nuevo perfil destinado a modelos uncensored, concretamente al modelo uncensored que teengo configurado de Deepseek. Quiero que crees el perfil con el nombre uncensored y asignes este modelo a todos los agentes y subagentes."
S2: "Además de esto, quiero que cuando esté utilizando modelos físicos y no virtuales esta extensión permita reintentar las llamadas un máximo de 3 veces, después de eso, realizará un timeout de 5 minutos y volverá a realizar la llamada hasta 3 veces, un nuevo timeout de 5 minutos y de nuevo 3 intentos de llamadas, de estee modo habrá 3x3 intentos con separaciones de 5 minutos entre ellos."
S3: "Si tras estos intentos sigue fallando se dará por finalizados los intentos de recuperación. Esto debe aplicar siempre que se esté utilizando un modelo físico y no un virtual que no ofrezca rotación de modelo y debe aplicar a todos los agentes y subagentes, vamos, el comportamiento por defecto de todos los modelos físicos que se utilicen."
S4: User selected model `subrouter-lingai/deepseek-v4.1-flash-1017-uncensored` for profile `uncensored`.

## Tasks
T1 | S1-S4 | parent inline | in progress | Define profile shape and physical retry semantics; create tests/spec before source writes.
T2 | S2-S3 | parent inline | pending | Implement physical-model recovery: 3 attempts per group, two five-minute group waits, nine dispatches maximum; exclude virtual selections and non-rotatable errors.
T3 | S1,S4 | parent inline | pending | Add `uncensored` profile entries for orchestrator and every configured agent/subagent; preserve existing active profile and credentials.
T4 | S1-S4 | parent checks | pending | Run focused and full offline tests, config validation, diff checks, and inspect final changes.

## Log
L1: "Quiero que crear un nuevo perfil destinado a modelos uncensored, concretamente al modelo uncensored que teengo configurado de Deepseek. Quiero que crees el perfil con el nombre uncensored y asignes este modelo a todos los agentes y subagentes. Además de esto, quiero que cuando esté utilizando modelos físicos y no virtuales esta extensión permita reintentar las llamadas un máximo de 3 veces, después de eso, realizará un timeout de 5 minutos y volverá a realizar la llamada hasta 3 veces, un nuevo timeout de 5 minutos y de nuevo 3 intentos de llamadas, de estee modo habrá 3x3 intentos con separaciones de 5 minutos entre ellos. Si tras estos intentos sigue fallando se dará por finalizados los intentos de recuperación. Esto debe aplicar siempre que se esté utilizando un modelo físico y no un virtual que no ofrezca rotación de modelo y debe aplicar a todos los agentes y subagentes, vamos, el comportamiento por defecto de todos los modelos físicos que se utilicen."
L2: Exploration found two configured DeepSeek uncensored IDs; user selected `subrouter-lingai/deepseek-v4.1-flash-1017-uncensored`.
L3: Existing virtual routing uses four passes and cooldowns. Direct physical selections currently bypass this extension entirely. Physical recovery must be extension-owned to express two exact five-minute waits instead of Pi's 60-second native delay cap.
L4: The profile is added as a selectable saved profile; the current active profile remains unchanged unless the user explicitly activates `uncensored` later.
