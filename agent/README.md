# Voice caller release evidence

`contract.json` is the output contract read by the Desk. The live caller is configured in Sarvam; this checkout does not contain an authoritative export of its running instructions.

Before a caller version may reach real businesses:

1. Export or otherwise preserve the actual committed caller instructions and configuration. Store the non-secret instructions as `agent/instructions.md`; do not invent a substitute or include provider credentials.
2. Compute the instructions/contract hash from those exact release files, following the root README's pinning procedure.
3. Run the caller suite on consenting test numbers. Preserve the agent version, instructions hash, contract version, suite result, and representative outputs together.
4. Record the matching gate and active version. The existing database guards additionally require that the version has actually returned every required output name.
5. Check the deployed version/configuration in the provider. A local hash and gate row do not remotely attest what the provider runs.

There is no new caller version or live-call qualification included in the reliability patch. Publishing an environment or deploying application functions does not complete this release step.
