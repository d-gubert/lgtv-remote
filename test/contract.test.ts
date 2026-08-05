import { effectClient } from "./contract/effect-client.js"
import { plainClient } from "./contract/plain-client.js"
import { runContractTests } from "./contract/suite.js"
import { runWireTests } from "./contract/wire.js"

/**
 * Both implementations of the protocol client, held to one description of it:
 * `src/sdk` on its own, and the Effect binding in `src/services/Tv.ts` that is
 * now a thin layer over it.
 *
 * The two adapters differ only in how a failure and a decoded shape are spelled
 * — everything the suites assert is behaviour neither is allowed to have on its
 * own. Neither `suite.ts` nor `wire.ts` changed while the SDK was extracted; a
 * case that had needed editing would have meant the port changed behaviour
 * rather than structure.
 */

runContractTests(plainClient)
runWireTests(plainClient)

runContractTests(effectClient)
runWireTests(effectClient)
