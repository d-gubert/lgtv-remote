import { effectClient } from "./contract/effect-client.js"
import { runContractTests } from "./contract/suite.js"
import { runWireTests } from "./contract/wire.js"

/**
 * The suites that have to stay green through the de-Effecting of the protocol
 * client. Add the Effect-free SDK here as a second adapter and run both:
 *
 *   runContractTests(plainClient)
 *   runWireTests(plainClient)
 *
 * Neither `suite.ts` nor `wire.ts` may change while that port is under way —
 * if one of them has to, the rewrite changed behaviour rather than structure,
 * and that is the thing worth arguing about.
 */

runContractTests(effectClient)
runWireTests(effectClient)
