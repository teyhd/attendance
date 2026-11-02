# Source recovery snapshot

This branch preserves the reviewed local code snapshot captured on 2026-11-03.
It is a recovery copy, not a production release or an automatic integration into the default branch.

Dependencies, compiled outputs, model weights, datasets, recordings, runtime databases, logs, machine configuration and operational reports are excluded.
Restore dependencies from the included manifests and provide private configuration through the environment before running the application.

Validation for this snapshot is recorded in the local audit manifest. An uploaded source snapshot does not certify a full application release.
