Subject: Early-access commercial use of Jev inside a resolution pipeline — confirming §2.3 posture and Order terms

Hi TypeSafe team,

I'm building Resolve, an automated resolution service for long-tail prediction markets, and I'd like to use Jev in it commercially under my early-access key. Before I take a paid query, I want to confirm three things against the Master Customer Agreement.

What the product does: a market condition is registered with its sources (GitHub API objects, Base and Solana logs, canonical web pages). Deterministic code fetches and hashes the evidence, runs an allow-list, anchor, integrity, time-window and injection screen, and resolves machine-readable cases itself (merged pull requests, published releases, on-chain logs, numeric thresholds). Only free-text evidence reaches Jev, as one systemOne call with a fixed battery of typed questions (outcome choice, subject match, explicit-statement, completed-vs-planned, negation, contradiction, steering, authority). Threshold logic in code turns those answers into a verdict that carries evidence hashes, provenance, the question battery version and the model id. Customers receive that verdict and provenance through Resolve's own API; they never receive raw Jev answers, cannot pass arbitrary questions, and cannot use Resolve as a general model endpoint. Jev's share of verdicts is measured and published.

The three questions:

1. §2.3(a)–(b): does a resolution API of this shape — a derived verdict plus provenance, with a deterministic majority path and no exposure of the model as such — sit within a permitted Customer Application rather than a "standalone service" or "similar or competing product"? If you need a wording change in how Jev is described to customers, I'll adopt it.

2. Order terms for my early-access key: the request-per-minute and token limits you'd like me to design against, and the price per million input tokens I should budget with. The docs list 1,200 rpm and $0.042/M with a note that limits adjust dynamically; I want the numbers you'd stand behind for this account.

3. Whether early access may be used commercially now, or whether you'd prefer I hold paid Jev-backed queries until a general-availability agreement. Until I hear back, paid routes serve only the deterministic path; the shadow track-record calls run at a few cents per month.

Volume for the first 90 days is small (thousands of calls per month at ~3k tokens each). I'm pinning jev-1.13.0 and re-running a frozen adversarial suite before any version change; happy to share the suite and results if useful.

Thanks,
Rafae Musharraf
Resolve — rafae19539@gmail.com
