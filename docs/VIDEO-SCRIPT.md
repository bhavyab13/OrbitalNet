# OrbitalNet — narration scripts (you read; the dashboard runs the demo)

Open **http://localhost:5173** full screen. Press **1**, **2** or **3** (or the buttons). Each demo runs itself at 2× sim speed and shows a step strip at the bottom; read the line for the step that is on screen. Second screen (optional): Stripe → Payments, and the InstaBox console. The same numbers appear in the dashboard's live Stripe and InstaBox panels, so you don't have to switch.

## Hook (before pressing anything, 12 s)
"Three thousand eight hundred fires are burning in Papua right now. That's NASA data from this morning. A satellite just photographed them, and the people on the ground need a fire map in twelve minutes. The satellite can't deliver it: its next ground pass is twenty-five minutes away. What you're about to see is a new protocol that lets that satellite rent a stranger's computer and a second stranger's radio, pay them, and get the map down in time, with every step enforced in code."

## Demo 1 — Impossible alone (press 1, ~70 s)
| Step on strip | Say |
|---|---|
| ① Mission arrives | "Every satellite here is real, propagated from today's orbital elements. The contact windows are modeled. Six candidate plans, and only two work. Both need two different companies' spacecraft." |
| ② Discover + quotes | "The agent reads each operator's signed manifest and gets a quote bound to a specific ninety-second window. No API integration. Just the protocol." |
| ③ E1 withdraw | "First failure, on purpose: the relay pulls out between quote and commit. Zero dollars moved. The compute hold is released. Commitment is conditional across owners, or an agent can't be trusted with a wallet." |
| ④ Pay + grants | "**Stripe.** Each reservation is a Machine Payments Protocol 402. The agent pays, Stripe records the PaymentIntent you see landing on the right, and the provider signs a grant bound to that receipt." |
| ⑤ Crosslink + inference | "**InstaBox.** That compute satellite is a real machine we don't control. It verifies the grant with its own key and the world's signed clock, offline, then runs real fire detection on the real scene." |
| ⑥ Metered downlink | "**Stripe sessions.** The relay bytes are metered: a fifth of a cent per hundred kilobytes, settled to Stripe a cent at a time. Pay for exactly what moved." |
| ⑦ Delivered + reconcile | "Delivered under the deadline. And the books balance: every receipt matches a grant, every grant matches a signed attestation of the work. That triple is the protocol." |

## Demo 2 — Outage, refund, and a stranger (press 2, ~90 s)
| Step on strip | Say |
|---|---|
| ①–③ (fast) | "Same mission, same two strangers, paid and working." |
| ④ Outage | "Now the break that matters: the ground station dies after the work is done. Watch the gold particle return: the relay refunds its grant with a signed voucher. The green ring stays: the result is preserved on the satellite." |
| ⑤ Waiting | "And the agent refuses to invent an answer. No path exists. It watches the marketplace." |
| ⑥ Northstar boots | "**InstaBox.** A provider the agent has never seen boots from a snapshot, on its own machine, and publishes a signed manifest. The agent verifies it from the signature alone and pays it. Discovery to contract in one mission, zero integration code." |
| ⑦ Fast-forward + downlink | "We jump the clock to the new contact window, as an operations centre would wait. Metered downlink through Starlink, settled to Stripe." |
| ⑧ Delivered | "Delivered on the second route. Refund, new provider, and settlement all reconciled." |

## Demo 3 — Intent changes the deal, and a provider lies (press 3, ~60 s)
| Step on strip | Say |
|---|---|
| ① Mission arrives, budget $1.50 | "Different ask: rough extent is fine, keep it under a dollar fifty. Now the full-fidelity plan is over budget and the market offers something else." |
| ② Low-fidelity crop chosen | "The agent buys a forty-megabyte downsampled crop instead of on-orbit analysis. Cheaper, same deadline, lower fidelity, and it says so." |
| ③ Pay | "**Stripe** reservation, as before." |
| ④ 40 MB metered | "Here's the micropayment architecture at full tilt: forty megabytes through the relay, four hundred units, settled to Stripe one cent at a time. Count them on the right." |
| ⑤ Delivered, low fidelity | "Delivered: a real downsampled image, labelled low fidelity." |
| ⑥ Reconcile catches a lie | "One more thing. That relay over-reported its usage. The attestation is validly signed, so only reconciliation catches it: receipt, grant and attestation disagree, and the provider is marked untrusted for the next mission. Trust is a protocol output, not an assumption." |

## Close (10 s)
"Satellites are the hardest case: the resource is in the future, the machine is offline when you use it, and the owner is a stranger. The same protocol works for GPUs, drones and edge cameras. OrbitalNet."
