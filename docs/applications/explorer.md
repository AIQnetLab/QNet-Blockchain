# Block explorer

This document describes the QNet block explorer in `applications/qnet-explorer`: a Next.js 16
application that serves block, transaction, address and token views from a PostgreSQL index that a
separate indexer process writes. It covers what the explorer shows,
how the three parts fit together, how chain data is ingested, which environment variables the
deployment needs, and how to run it locally.

## Layout

| Path | Role |
| --- | --- |
| `frontend/src/app/` | Next.js App Router pages and HTTP API routes |
| `frontend/src/components/` | UI components: the header (its links, the Docs menu and the wallet control), the footer, token icons, UI primitives |
| `frontend/lib/` | Web-tier server modules: read-only database access, security checks, rate limiting, monitoring |
| `frontend/src/lib/` | Client and shared helpers: the node client, caching, token formatting, transaction mapping, the wallet-extension provider client (`qnet-provider.ts`) |
| `frontend/src/indexer/` | The indexer process: node client, chain follower, writer, migration runner |
| `frontend/src/server/head-hub.ts` | The per-process head snapshot the web tier serves |
| `frontend/src/server/light/` | The balance check: the light client that verifies macroblocks' committee certificates from the pin, the state-tree proof checks, and the certified balance proof with the old-node fallback |
| `frontend/src/server/link-relay.ts` | The per-process QNet Link relay store behind `/api/link/*` |
| `frontend/src/server/cabinet/` | The node cabinet's server side: `node-proxy.ts` (a light node's status, balance and history, and a super node's status, from the genesis nodes), `wallet-node.ts` (whether a wallet has a node of either type), `solana-proxy.ts` (the activation's price, payment address, blockhash and transaction reads, and the one door its burn and refund go through), `burn-parse.ts` and `burn-scan.ts` (an activation burn read from Solana, and the search of a wallet's Solana address for one), `activation-registry.ts` and `activation-api.ts` (the activation registry: one record per wallet, below), `register.ts` (the registration submit), `registration-record.ts` (a registration's burn from the archive), `wake.ts` ("I'm back") and `limits.ts` (the origin checks and per-client limits of every `/api/cabinet` route) |
| `frontend/src/server/phone-flows.ts` | `CABINET_PHONE_FLOWS`: whether the cabinet sends QNet Wallet its `link` and `claim` requests |
| `frontend/src/server/wallet-apk.ts` | `WALLET_APK_URL`: the Android file `/wallet` offers, if any |
| `frontend/src/lib/cabinet/`, `frontend/src/components/cabinet/`, `frontend/src/lib/texts.ts` | The node cabinet's shared logic (the wallet choice, the reading of a node's state, the wallet's activation from every source in `wallet-activation.ts`, the record proof in `burn-record.ts`, the tabs, the activation's stages and payment requests), its components, and the site's English texts |
| `frontend/src/lib/faucet-handover.ts` | The connected wallet's Solana address and the faucet pass handed from the cabinet's payment card to the Testnet page's faucet, in the tab's session storage, each read once; the request for the pass |
| `frontend/src/server/faucet-guard.ts`, `faucet-budget.ts`, `faucet-pass.ts` | The faucet's admission (per address, per wallet with a pass, per IP, per network block, and each hour's budget, most of it kept for claims with a pass) and the faucet pass |
| `frontend/src/lib/qnet-link.ts`, `qnet-link-crypto.ts`, `link-client.ts`, `link-store.ts` | QNet Link on the page: the link, the request and the answer, the key exchange and the check number, the relay client, and the one unfinished session a cabinet page keeps in the browser |
| `frontend/src/server/request-guard.ts` | The checks of the relay and the faucet: `Origin`, `Sec-Fetch-Site`, JSON media type, body cap |
| `frontend/src/server/solana-tx.ts`, `solana-rpc.ts`, `faucet-tx.ts` | The faucet's Solana transactions, built, signed and confirmed without a Solana SDK |
| `frontend/src/server/faucet-cooldown.ts` | The faucet's per-(address, token) and per-(wallet, token) cooldown in process memory, each entry dropped after its 24 hours |
| `frontend/src/server/logo-proxy.ts` | Token logos fetched by the server and served from the site (`/api/token/[contract]/logo`) |
| `frontend/migrations/` | Ordered schema migrations: `001_init.sql`, `002_batch_transfers.sql`, `003_indexer_v2.sql`, `004_address_history.sql`, `005_cabinet_activations.sql`, `006_cabinet_activations_reservation.sql`, `007_cabinet_activations_burner.sql` |
| `frontend/scripts/` | Timestamp backfill, PostgreSQL install/backup/restore helpers, and `run-migrations.ts` behind `npm run db:migrate`, which reads only `001_init.sql` |
| `frontend/ecosystem.config.example.js` | PM2 layout running the web tier and the indexer side by side, as the unprivileged app user |
| `deployment/deploy-aiqnet.sh` | Provisioning of the aiqnet.io host: Node.js 22, the `aiqnet` user, pm2, nginx, TLS |

The repository root of the explorer is a workspace whose `dev`, `build`, `start` and `lint` scripts
delegate into `frontend/`.

## What it shows

- `/explorer` — chain overview with recent blocks and transactions.
- `/explorer/block/[hash]` — block detail.
- `/explorer/tx/[hash]` — transaction detail, with the recipient list of a `BatchTransfers` envelope.
- `/explorer/address/[address]` — address page: balance, native transactions with incoming
  batch-transfer credits, and token transfers.
- `/explorer/tokens` and `/explorer/token/[contract]` — deployed token list, per-token page and
  holder list.
- `/explorer/qnc` — native QNC overview backed by the node rich list (top holders, total and
  circulating supply). QNC is the native coin, so this is a coin view, not a QRC-20 token page.
- `/wallet`, `/qnet-wallet-extension`, `/testnet`, `/dao`, `/docs`, `/docs/how-it-works`, `/privacy`, `/terms`,
  `/support` — informational sections: the mobile wallet and the browser extension, the testnet faucet for 1DEV and
  SOL on Solana devnet, the DAO page, the documentation index, How it works (below) and the pages the app stores link
  to. `/wallet` describes the one app on every phone and tablet and, once `WALLET_APK_URL` is set, offers its
  Android file, the same Play-signed build as Google Play; the app does not update itself. It links the Google Play
  listing (https://play.google.com/store/apps/details?id=io.aiqnet.wallet, `ANDROID_PLAY_URL` in
  `src/lib/app-links.ts`); the App Store listing is in preparation. The
  Terms carry the Device rules of a light node and the privacy policy its device check; Support says what to do
  when the Node tab says the node is paused on a device or that the device can't run one: run it on another phone
  or tablet (install QNet Wallet from the app store, restore the wallet, Use this device), with no review step; and,
  outside the app's view, the move from the older Android app installed from a file (install QNet Wallet, restore
  with the recovery phrase). Its section on what delays or skips a node's answers says that every answer belongs to
  its own epoch: the network repeats its requests during the epoch, an answer counts only before that epoch's check
  closes, about 2.5 minutes before the epoch ends, and an answer after it counts for no epoch, the next one
  included. `/nodes` is a permanent redirect to `/explorer` and
  `/activate` one to `/node/activate` (`next.config.js`).
- The header (`src/components/Header.tsx`): the QNET logo leads home, then Explorer, My node (`/node`), Wallet,
  Testnet (its own tab on a testnet release, where the faucet is) and a Docs menu (Documentation, How it works, DAO,
  Support), and the wallet control. On a
  window 860 px wide or narrower the links, the Docs menu (its list in place) and the wallet control move into the
  menu button's panel. The footer (`src/components/Footer.tsx`) links Privacy, Terms and Support on every page, and,
  outside the app's view, the Google Play listing.
- `/node`, `/node/activate`, `/node/device`, `/node/history` — the node cabinet, My node. The visitor chooses a
  wallet: the QNet extension (`qnet_requestAccounts`), an address typed there (only to look: every action the wallet
  itself confirms asks to connect it first), or QNet Wallet asked with a QNet Link `connect` request ([QNet Link
  v1](../protocols/qnet-link-v1.md) section 14: a button on a phone or tablet, on Android an `intent:` URL naming
  `io.aiqnet.wallet`, and a QR code drawn in the page on a computer or for another device). The choice, with how it
  was made and the Solana address the wallet shared, is remembered in the browser (`qnet.cabinet.wallet`); an address
  from a QR request, which anyone who saw the code could have answered, is marked as such. With no wallet chosen, the
  cabinet takes up the extension's wallet by itself when the extension's `qnet_accounts`, which never opens a window,
  shows it already approved the site, and follows it when the extension answers with another wallet; a wallet chosen
  another way is never replaced. Until the extension has answered, a page whose wallet that answer may set shows
  nothing. Disconnect leaves a mark (`qnet.cabinet.disconnected`) that stops this until a wallet is connected with a
  tap (an address typed only to look is not one, and leaving it with Connect your wallet is no Disconnect). Before a
  wallet the page shows the connect screen with How it works in short.
  With a wallet it shows the whole address (a tap copies it), how it was connected, Disconnect, the way to a running
  node (Connect, Activate, then Link a device and Running for a light node, or Run the server and Running for a super
  node) and the tabs Overview, Device and History, plus Activate only while the wallet has nothing anywhere or while an
  activation of this browser for it is unfinished. What the pages show follows the wallet, whichever way it was
  connected and in whichever browser or device (`src/lib/cabinet/wallet-activation.ts`), from every source: the
  network (`GET /api/cabinet/wallet-node/{wallet}`, the light node's status and the super node's status: "no node" and
  "registered" only when the nodes settle it), the site's activation record of the wallet with its search of the
  wallet's own Solana address (`GET /api/cabinet/activation/{wallet}`, below), the QNet extension that holds the wallet
  (`qnet_getActivation`, read without a window: its activation, its burn on the way or its search), and on top what
  this browser keeps: the activation the extension reported for the wallet (`qnet.cabinet.activations`, at most five
  wallets) and the activations made here with a payment address. Every page shows one state: checking; the extension
  locked (or this site not approved), with nothing offered until it answers; a check that did not answer, named, with
  Try again and a read again every half minute; no node and nothing known (the only state that offers an activation,
  of either node type, the super node through the QNet extension only); another browser's or device's reservation
  (until when); a burn on its way; a known burn, whose code comes first with its next step (the record on the network
  and then Link a device for a light node, which any browser where the wallet is connected, a phone included, finishes
  with QNet Wallet whichever way the burn was made, `src/lib/cabinet/burn-next.ts`; every server step for a super
  node); a light registration being recorded; or
  the node or nodes on the network (both only for a wallet registered with both before the network's one-node rule).
  The pages move on by themselves: while a light node's record is awaited (a known burn, a registration being
  recorded, or a node listed before its status is read) the page reads the network every 5 s, and every 10 s while a
  recorded light node waits for its phone, a super node's burn for its server or a burn found only on Solana for
  QNet Wallet's consent, on top of the reads' own half-minute round and only while the page is shown, for at most 10 minutes from
  the step's start or the page's return (then the half-minute round alone); the watch stops once nothing is awaited.
  The cabinet's reads of a node stay modest: the node's status, a super node's status and the wallet's node on the
  network every 30 s while the page is shown and when it is shown again, one read shared by every part of the page;
  the watch above; and after "I'm back" sent a wake, the same status read every 10 s for 2 minutes. The site serves
  every status read from its cache per node, kept about the page's poll interval (25 s; a settled "not registered" 30
  s), so a node's genesis nodes see at most one round of reads per node in that time, whatever the visitors do, and
  each genesis node at most 20 page reads a second, 4 of them for ids nobody was seen registered with; a page that
  reported a link, an unlink or a move reads the status again once that cache is over. The moment the network lists the node, every page leads with the next step: for a light node
  without a device, "Link your phone"; a node that one node lists before two agree on its status shows as recorded
  with no device yet, never as an empty section.
  A bare `/node` opens Activate only for a connected wallet in the state "nothing known", else the Overview.
  The cabinet never renders in the QNet app's view (below). Its texts are English (`src/lib/texts.ts`), and the words
  it shares with the app and the extension are theirs. Every cabinet page says that a light node runs on one phone or
  tablet at a time, in QNet Wallet, and a super node on a server with the QNet node software. The site's matrix rain
  runs behind the cabinet as behind every other page; its cards, the way, the sections and any line outside a card
  sit on opaque, blurred panels over it.
  - Overview (`/node?tab=overview`): without a node, the state above and its next step; with nothing known, both node
    types ("Activate a light node", "Activate a super node": `/node/activate?type=light` or `?type=super`), with the
    note that a super node is activated only in the QNet extension on a computer and runs on the user's own server.
    A payment address's final burn with no node yet shows its code and, in a browser that does not hold its record,
    "Continue in QNet Wallet" on a phone ("Show the QR code" on a computer): a `link` request for that burn naming the
    wallet, whose verified consent the page posts to `POST /api/cabinet/register`, which adds the burner and the owner
    bind the site keeps; the browser that holds the record goes on with it on Activate. A light burn made from the
    wallet's own Solana address (the extension's or an older app's: in the site's record, in the extension's answer or
    found by the search of that address) shows its code and the same "Continue in QNet Wallet", on a phone as anywhere:
    the `link` request also names that address (`burner`, [QNet Link](../protocols/qnet-link-v1.md) section 14.4), QNet
    Wallet answers it only from the wallet whose own address it is, with that Solana key's owner bind beside the
    consent, and the page posts the whole body to `POST /api/cabinet/register`. Only in the browser whose QNet extension
    just made the burn does the page wait for the extension, which records the node itself; no other light burn sends
    to the extension. For a super node's burn, every
    server step: the ports, the node software's build, the recovery phrase in a file only the user reads, the start
    with its settings and the `docker run` command, and the health check. For a
    light node on the network: its state and the next step (while the network records a registration, how far it
    got, a note when the network does not answer, for an activation the extension made the phone's first steps that
    need no record (QNet Wallet installed, the same wallet imported) and after a few minutes, in a browser with the
    extension, "Record on the network": `qnet_activateNode` again, which for a wallet with an activation queues the
    record of the burn it has; once
    recorded with no device, "Next: link your phone or tablet" first on the page, with the steps so far (burned,
    recorded, the phone's now) and Link a device in numbered steps); the status card with the device's state (Online,
    Offline, or a new device waiting for its first answer; else no device), whether it answered this epoch and the
    counted epochs; beside the Offline state, the latest epoch the node was not counted in (below), and, in that card
    right under the device rows and nowhere else, "I'm back" only while the public
    status names the device Offline and it has not answered this epoch (never for an Online device, a device linked
    less than an epoch ago that has not answered yet, or no device; for a node of an earlier version, a linked device
    the network asks to come back). Pressed, the site asks the owners of the node's light shard in rank order for one
    silent push to the device (`POST /api/cabinet/wake`, below); after a push the page says that it waits for the
    device's answer and reads the status again every 10 s for 2 minutes, and once the status says the device answered
    this epoch the card shows it Online and I'm back goes; with no answer by then, that QNet Wallet should be opened
    on the device. Any other answer is said as it is: already answered, no device answers, or that the network cannot
    wake the device right now, with the minutes until it can when the network names them; then, for every registered node (with a device linked or not), the node balance:
    each counted epoch adds to it, the network keeps it for the wallet, and from 1 QNC Move to wallet puts it in the
    wallet, through the extension of this computer for its own wallet (`qnet_claimNodeBalance`), otherwise a `claim`
    request to QNet Wallet; the answer is the wallet's report and the balance is read again from the network. While
    I'm back shows, the move waits. Then Node details: the activation code with Copy, the node type, the node
    id, the burn with its link and amount and the block the node was recorded at, from the archive's registration
    record, else the site's record, the extension, the burn found on the wallet's Solana address, the extension's
    answer kept here, else an activation of this browser. The code encodes the wallet the burn is for: the wallet's
    code for a burn a payment key made, the burner's code for a burn from the wallet's own Solana address (the
    extension, an earlier QNet Wallet, a registration QNet Wallet signed with its owner bind v1; always so for a super
    node). Exactly one code is shown. Whose burn it is the page takes from what it knows: the burner is the Solana
    address the wallet shared or its extension burned from (the burner's code); it is one of this browser's payment
    addresses or made their burn (the wallet's code); the site's record, the extension's answer or the answer kept here
    names this burn's code or way; the page knows the wallet's address and another one burned (the wallet's code). Else
    it takes the registration route's `burnBy` (below); until either tells, the row says the code follows later, and the
    route is read again every 30 s while the page is shown (a read that fails keeps the answer before it). The
    code is shown by itself, and the page never asks for it: a light node never needs it, a super node's server takes
    it in its settings. Last, the newest epochs. For a super node on the network: online or offline (the nodes' peer
    view or its on-chain heartbeat), when it was last seen (the nodes', else the archive's newest heartbeat), its
    heartbeats this epoch against the number needed, whether the network bars it, its counted and missed epochs, its
    node balance (moved from QNet Wallet's Node tab), its details with the server's settings, and its newest epochs.
    A wallet with both shows both.
  - Device (`/node/device`): for a light node, the linked device from the public status's `device` ([light node
    messages](../protocols/light-node-messages.md) section 7): its state (Online, Offline, or a new device waiting
    for its first answer), its model and platform as the device said them when it linked ("Pixel 8 · Android"; the
    platform alone when no model is known: Android, iPhone or iPad, or an unknown device; display only), the UTC day it
    linked, whether it answered this epoch, and the epoch of its last answer; for a node of an earlier version, which
    names no device, the last counted epoch instead. A typed-in address (view only) shows the platform, the state and
    the epochs alone: no model, no linking day and no miss. The keyless status carries no exact time of an answer or a
    wake, no delay and nothing of what QNet Wallet did with a wake, and the page shows none of it, also while a node of
    an earlier version still sends them (the site drops them before its cache). For an Online or Offline device, the
    latest epoch the node was not counted in, as one line, while that epoch is newer than the last counted one and no
    answer of that epoch or a later one came (`src/lib/cabinet/last-miss.ts` `shownMiss`; on the Overview the same line
    shows beside the Offline state), and on this tab also after the node was counted again when the record carries the
    device's own account of the wake (`deviceMiss`: the device sends that account with its next answer, which in a later
    epoch counts the node again): what happened in that epoch (the network sent the device a wake and no answer came
    before that epoch's check closed; the wake never reached the device, the push service or the device held it; the
    device answered after the check closed; its answer was refused; the network has no way to wake it; the network
    stopped waking it after two epochs without an answer; the network did not get its wake out to the device in that
    epoch; the network published no check of the node's group in that epoch, so no node of the group was counted),
    whether the wake reached the device when the record knows ("The wake reached the device."), and what to do: let
    QNet Wallet run in the background on that device with its battery use unrestricted (Background App Refresh on, on
    an iPhone or iPad) and do not swipe it away (woken without an answer, wake never arrived, answered late), run the
    node on that device again from QNet Wallet (answer refused), open QNet Wallet on that device once (no way to wake
    it), open QNet Wallet on that device or press "I'm back" (stopped waking it; "on the Overview" on this tab, and the
    I'm back part only while I'm back is offered), and for the last two, that it was the network's miss and nothing
    needs changing on that device or in QNet Wallet. Those two (`not_sent`, `not_committed`) never count toward the
    network's stopping to wake a device: two missed epochs stop it only when both are proven misses of the device,
    where the shard's check was committed without the node and the owner's own record shows the device was reached
    (the push service took the push, the device fetched its challenge, or the push service said its address is gone);
    a push the service took that the phone's system then held counts as reached, alike on iPhone, iPad and Android.
    Every answer belongs to its own epoch: no line says an answer counts for another, and an answer after an
    epoch's check counts for none. An Offline device's card leads to
    the Overview, where "I'm back" is. With a device linked, "Unlink the device" and "Move the node to another
    device". Once both genesis nodes list `unbind_wallet`, the wallet signs the unlink with its own key, so a lost
    device is unlinked from here too: the QNet extension of this computer when it holds the chosen wallet
    (`qnet_unlinkNodeDevice`), otherwise an `unlink` request naming the wallet, its QR code or its button, which QNet
    Wallet with that wallet on any device confirms; before that, the same request goes to QNet Wallet on the device
    that runs the node, whose own key signs its unbind, and a lost device leaves when the node moves to another device.
    The page unlinks nothing alone; the answer is the wallet's report (taken by the network, or not confirmed) and the
    rows follow the network. "Move the node to another device" is the `link` request without a burn: the device that
    confirms it runs the node and the one before it stops. With none linked, Link a device in numbered steps. For a
    super node, that it runs on its server with no device to link, and the server's status.
  - History (`/node/history`): the counted epochs out of the last ones a genesis indexed, the counted epochs still in
    the node balance, and every epoch since the registration one by one, up to the newest 400 (a node from before the
    cabinet included: its id derives from the wallet): when it ended, counted, moved to the wallet, missed, not checked
    by the network or not readable, the node balance it added and the transaction that moved it; older epochs the
    archive knows only as moved. A super node's epochs the same way, from its registration's epoch
    (the archive's `NodeRegistration` row sent from the super node's id).
  - Activate (`/node/activate`): an activation is offered only while every source of the wallet says it has
    nothing (the state "nothing known"); otherwise the page shows the wallet's state and next step instead (for a
    wallet whose node the network lists, the step it is on: "Link your phone" with Link a device one tap away on the
    Device tab, or the Overview, where "I'm back" is for an Offline device). One
    wallet, one node: a light node or a super node, chosen once. A super node is activated only in the QNet extension
    on a computer; without the extension the page shows its card ("Super node: only in the QNet extension", with the
    extension's install link on a computer and the super node guide on a phone), first when `?type=super` asked for it.
    On a computer with the QNet extension that holds the chosen wallet (the wallet the cabinet took from it, or the one
    it answers with) the page offers both node types (`?type=super` preselects the super node); an extension that holds
    another wallet is never offered for this one, since it burns for its own wallet only, and the page says so. The
    extension holds the wallet's reservation, burns
    from its own Solana address and, for a light node, records the node in the same approval (`qnet_activateNode`,
    [QNet Link v1](../protocols/qnet-link-v1.md) sections 10 and 14.10); the page checks every field of the answer,
    recomputes the activation code, keeps the answer for the wallet, reads every source again, and shows "Registered"
    once two genesis nodes list the node, or once the network lists it for the cabinet's wallet, then "Link your
    phone" by itself. Neither another node type nor Try again brings the burn button back
    while the wallet has an activation, a burn on its way or a source that did not answer. A super node gets its
    server's settings and steps, never a phone. A version of the extension without `qnet_getActivation` (4200) leaves
    the extension's source unknown and is told to update. While the phone flows are on, the page also makes a one-time
    payment address in the browser, for a light node only, with or without the extension (its card is titled "Light
    node: pay with a one-time address"). The payment key signs only the owner bind v2, which the network takes from its
    one-wallet-one-node gate on: so the card offers the address only once the two genesis nodes that settle the wallet's
    light node status both list `owner_bind_v2` (the features both list, `activation.ts` `paymentOpen`); before, it says
    that activation from a payment address is not open yet, no address is made and nothing can be burned, and the same
    check runs again right before a burn is signed. A node that answers a submit `bind_v2_pending` (the bind verifies,
    the network does not take it yet) is a retry, said calmly: the burn stays the wallet's and nothing is burned again.
    QNet Wallet first confirms the wallet the node is for: the page opens a
    `reserve` request naming the chosen wallet and the new payment address ([QNet Link v1](../protocols/qnet-link-v1.md)
    section 14), QNet Wallet shows "Set up a light node for this wallet" and answers with the wallet's signed
    reservation, and only then does the page show the address; a decline, an error, another wallet's answer or a
    request that expired deletes the record, whose address was never shown. The
    user sends the activation price in 1DEV and 0.001 SOL (the burn's fee and the address's rent-exempt minimum,
    rounded up) to it from their own wallet: the card says which QNet wallet the node is registered to, and shows a QR
    code of a payment request
    `solana:<address>?amount=<price>&spl-token=<1DEV mint>&label=QNet%20activation` that fills in the address, the
    token and the amount in the wallet that scans it, and a second, small one for the SOL, each with "Copy payment
    request"; on a phone it says to copy the address and send both amounts from QNet Wallet; on testnet it links the
    Testnet page's faucet ("Get them to your wallet"), handing over the connected wallet's Solana address without a
    URL (`src/lib/faucet-handover.ts`), with the faucet pass the site gives for the wallet's signed reservation (see
    Faucet). Then the page burns (only for the connected wallet that signed the reservation,
    while its state is still "nothing known" or this browser holds its reservation, else Burn gives way to that state;
    and only under its reservation, made with the wallet's signed reservation: the server checks the network, its
    record and the wallet's Solana address first, and the payment key signs only with at least two minutes of the
    reservation left; a signed reservation the server finds too old asks QNet Wallet to confirm again, the address
    kept). Right after the burn is signed and before it is sent, the payment key signs the owner bind v2 of the
    wallet's light node, and the site takes the burn only with it: once final, the burn is the wallet's activation for
    good and its code shows at once. The page then has QNet Wallet confirm the node with a `link` request naming that
    wallet and submits the wallet's consent, which the server completes from its record before a node gets it; from a
    node of either type already on the network for the wallet nothing is submitted (one wallet, one node), and the
    network's refusal `wallet_has_node` is shown as such. Every stage is kept in the browser's record and taken up again
    after a reload, whichever way the wallet is connected then. Before a burn the payment address's key lives at most 24
    hours from the start. After a burn it is kept only to send back what is left: once the node is recorded, or at once
    with "Send what is left back now" (`flow.ts` `mayReturnLeftovers`); the burn stays the wallet's in the site's record
    and nothing is released, since the registration can be finished in any browser where the wallet is connected. When
    the key ends, what is left on it (1DEV, SOL, its token account's rent) goes back to the wallet's own Solana address,
    when the extension or a `connect` on the same device shared it (on mainnet the page otherwise asks for it; test
    tokens are not asked for), and the key is deleted; the page then offers a new payment address, or, for a wallet that
    has its node or an activation by then, says that it needs none (`act_closed_has_node`). On mainnet an unrecorded
    address with nothing on it keeps its key until the user deletes it. A recorded activation keeps a receipt.
  - Pieces that expire are asked for again in one tap, the progress kept: a QNet Wallet request past its ten minutes
    ("Ask again", a new request with the same content), a consent QNet Wallet gave more than 24 hours before the
    record ("Ask QNet Wallet again", for the same burn, whose code and wallet stay), a Link a device QR code, and an
    extension window that closed or timed out (Try again at the same step).
  - The sections of before redirect (`next.config.js`): `/node/devices` to `/node/device`, `/node/claim` and
    `/node/code` to the Overview (307), and `/node/guide` to `/docs/how-it-works` (308); `/node?tab=` with an old
    section's name goes to its new place too.
  - How it works (`/docs/how-it-works`, in the Docs menu and linked from the connect screen; `?way=phone`,
    `computer` or `super`): short plain steps, each with a picture that draws only the labels the app, the extension
    or the site shows on that screen, then the questions people ask; readable without a wallet.
    - Phone only (14 steps, only with `CABINET_PHONE_FLOWS` on): "Create New Wallet" or "Import Existing Wallet" in
      QNet Wallet (a phone with a screen lock asks for no password), the 12 words and their check, aiqnet.io/node in
      the phone's own browser and the connect, QNet Wallet's confirmation, the payment address and its funding (Copy,
      then send from QNet Wallet), the burn and its code, QNet Wallet's second confirmation, which registers and runs
      the node, and the move of the node balance on QNet Wallet's Node tab (or with QNet Wallet from My node).
    - From a computer (13 steps): the QNet extension and its "Create or import a wallet" ("Create a new wallet" or
      "Import a wallet" in its setup tab), the 12 words, their check and the password, the Solana address and the
      tokens, the connect, the burn in the extension, the same wallet imported in QNet Wallet on the phone, Link a
      device on the Overview (or the app's Node tab, Use this device), and the move of the node balance.
    - Super node (14 steps), activated only in the QNet extension on a computer: the same first eight steps, the burn,
      the code and every server step on the page right after it and on the Overview later in any browser, the server
      with the node software (linked to Running a node), what the Overview shows, and the move of the node balance on
      QNet Wallet's Node tab with the same wallet imported.
    No step asks to keep the app running or names a phone setting (Support keeps those), and no answer sends the
    reader to write to anyone or to a button only the phone flows show. The connect screen's short version shows the
    three ways in three steps (phone) or four (computer, super node), each starting with create or import.
  - With `CABINET_PHONE_FLOWS` off (the deploy default) the cabinet sends QNet Wallet no `link`, `claim`, `reserve`
    or `unlink` request and the relay opens only `connect` sessions: the read pages, "I'm back" and the
    extension's paths stay (the extension's unlink among them), and the payment address is not offered. Without the
    extension, Unlink then says the node leaves a device when another device takes it over or when the wallet is
    deleted in QNet Wallet on it.
- The site has one origin, `https://aiqnet.io` (`src/lib/hosts.ts`, `src/proxy.ts`): the relay's and
  the faucet's `Origin` check, the extension's activation origin and the app's relay base all name it. A
  production build answers any other `Host` (`www.aiqnet.io`, `explorer.aiqnet.io`, an unknown name) with a
  308 redirect to the same path and query on aiqnet.io, API routes included; a run on `localhost` or
  `127.0.0.1` serves as is, and a development build serves every host.
- `link.aiqnet.io` is served by the same app: `/l` there is the page a browser shows for a link the app did
  not open; on Android it offers the button that opens QNet Wallet (`io.aiqnet.wallet`, the same Play-signed
  file from Google Play and from aiqnet.io), reading its own
  URL only through the link parser and sending it nowhere. The link page renders outside the site's shell
  on every host (`src/components/SiteShell.tsx`): no wallet context, wallet control or navigation. That host
  serves only its exact files (`/l`, the two app-association files, `/manifest.json`, and the icons the page head
  and the manifest name: `/favicon.ico` with 16, 32 and 48 px and the PNGs of 16, 32, 48, 128, 180, 192 and 512 px,
  each that size); every other path there, API routes included, is a 308 redirect to the same path on
  aiqnet.io, whatever the request's headers (a prefetch or router request included). The build assets under
  `/_next/static/` are served there as files (a missing one is a plain 404), and any page rendered for that
  host renders outside the shell. nginx passes every proxied request's own `Host`, so no location hands the
  app `127.0.0.1`, which it would serve as a local run.
- `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` (served on both hosts)
  name the apps allowed to open `link.aiqnet.io/l` links, from the constants in `src/lib/app-links.ts`;
  an app whose signing identity is not known yet is left out, and `npm run check:release` fails until
  all are set.
- The header's wallet control (`src/components/wallet/connect-wallet-button.tsx`) shows, on every page, the
  wallet the node cabinet shows (the one it remembers, or the extension's it takes up) and leads to `/node`.
  Without one, **Connect wallet** on a computer with the QNet extension asks the extension at once
  (`qnet_requestAccounts`, the connect card's call), and My node keeps that wallet and opens; on a phone or tablet, or
  without the extension, it leads to the cabinet's connect screen (on a page that shows the connect card it brings the
  card into view). In the QNet app's view (below) it connects the page's wallet provider instead
  (`src/lib/qnet-provider.ts`, state in `src/contexts/AppContext.tsx`). Connecting gives the site the approved QNet
  and Solana addresses only; it asks the wallet for no signature and no transaction.
- Every page response carries a Content-Security-Policy with a per-request script nonce
  (`src/proxy.ts`, the Next.js 16 proxy), prefetch and router requests included; the cabinet's pages add
  `worker-src 'none'`, `frame-src 'none'`, `manifest-src 'self'` and, in production, `upgrade-insecure-requests`.
  API responses carry their own restrictive policy (`next.config.js`). Pages load images only from the site and `data:`: a token's on-chain logo is
  fetched by the server and served from `/api/token/[contract]/logo`, so a visitor's browser never contacts
  the host a token's deployer chose.
- The QNet app's store builds show no activation, payment, other-platform or sideload text, and the site
  holds to that wherever those builds show it (`src/lib/activate-view.ts`): in the app's in-app browser
  (provider `channel` `mobile`), and on a page the app opens in the system browser with the marker
  `?from=app` (kept for the visit, in memory, on the header's links and on every link and navigation
  between explorer pages, `src/components/ExplorerLink.tsx`, so a reload or a new tab stays in that view). There, and in the server's render
  and before the wallet is detected, the header links only the explorer, Privacy, Terms and Support (no Docs menu),
  the logo leads to the explorer, and the footer links no place off the site (no repository, Telegram, X or store; its
  Privacy, Terms and Support keep the marker);
  Support hides the documentation, the repository's issues and the Telegram channel, so its only way off
  the site is the support address. In a browser without a wallet the header's wallet control offers no install target there (it would
  lead to the wallet pages and drop the marker). `/`, `/docs`, `/dao`, `/testnet`,
  `/qnet-wallet-extension`, `/wallet`, `/activate` and the node cabinet `/node` show nothing in the app's view and go to `/explorer`
  (`src/components/InAppGuard.tsx`); before the wallet is detected, the server's render included, their
  markup is in the page but hidden. Privacy and Terms describe activation without pointing
  to a page that performs it. `npm run check:release` fails until the app opens its policy, support and
  explorer links, and the App Store listing its Marketing URL, with that marker.

## Architecture

Three parts, each its own process:

1. **Web tier** — one Next.js application. Pages are rendered by Next.js; the routes under
   `src/app/api/` are the explorer's own HTTP API. They read the PostgreSQL index through
   `lib/db.ts`, which issues only reads, and proxy the node directly for anything that must be live
   (rich list, search fallback, balance checks). `src/instrumentation.ts` runs once per server start
   in the Node.js runtime and starts the head hub.
2. **Indexer** — `src/indexer/`, compiled by `npm run build:indexer` into `dist-indexer/` and run by
   `npm run start:indexer`. It is the only writer: at start it takes the session advisory lock
   `pg_try_advisory_lock(hashtext('qnet-explorer-indexer'))`, exits if another indexer holds it,
   applies pending migrations and then follows the chain. It commits with `synchronous_commit = off`
   and at start re-derives the gaps from 5,000 heights below its stored prefix, so rows a crash lost
   are fetched again.
3. **Database** — PostgreSQL. The web tier can connect as a read-only role that writes only
   `cabinet_activations`, the node cabinet's activation registry (below); the indexer needs write access.

Every block commit is one transaction. A commit that writes the head block, a delete that moves the
head and a reset each send `NOTIFY explorer_head` inside their transaction.
`src/server/head-hub.ts` keeps one `LISTEN` connection per web process and on each notification
refreshes one snapshot — `explorer_stats`, `sync_state` and the latest 50 enriched transactions —
that `/api/stream`, `/api/head` and the default first page of `/api/activity` serve from memory and
`/api/network/stats` takes its head and totals from; without a `LISTEN` connection it re-reads every
5 s. The overview, home and address pages follow the head through `useChainHead`: one `EventSource`
on `/api/stream` per tab, closed while the tab is hidden, with a 15 s poll of `/api/head` when the
stream fails. On a new head the overview refetches its default first page, the home page its stats at
most every 10 s and the address page its data at most every 3 s.

The migration runner (`src/indexer/migrate.ts`) applies every `migrations/NNN_*.sql` file not yet
recorded in `schema_migrations`, in name order, each file as one transaction. A database whose tables
predate that ledger is baselined by recording `001_init.sql` and `002_batch_transfers.sql` without
running them. `003_indexer_v2.sql` and `004_address_history.sql` set `lock_timeout = 5s` and `statement_timeout = 15min`, so a
migration that cannot take its locks fails rather than holding the read tier behind them; `005_cabinet_activations.sql`
creates the activation registry's table with `lock_timeout = 5s` and grants it to the role `explorer_reader` when one of
that name exists; `006_cabinet_activations_reservation.sql` adds the unique partial index on its `reservation`, which every
payment send and announce looks its row up by. The
optional `pg_trgm` GIN index that makes token free-text search index-served is applied by hand.

## Ingestion

The indexer reads from every endpoint in `QNET_API_URLS` (comma-separated; `QNET_API_URL` when it is
unset) and sends `X-API-Key` when `QNET_API_KEY` is set. What enters the archive is what a quorum of
those endpoints names: with `n` endpoints the quorum is `floor(n/2) + 1`, and a value the block hash
does not cover needs `n - quorum + 1` matching answers, the smallest agreement that must include an
honest endpoint.

- **Identity.** Heights are read as compact header pages from `GET /api/v1/blocks/headers` (up to 1,000
  per request), asked of every endpoint not in quarantine at once; a page returns once every endpoint
  has answered, once a quorum has answered and at most one endpoint is outstanding, or 6 s after the
  request if a quorum has answered by then. A height is accepted with the hash a quorum names; its
  previous hash, merkle root, transaction count, producer and time need `n - quorum + 1` matching
  answers.
- **Bodies.** A block with transactions is fetched from `GET /api/v1/microblock/{height}` (responses
  over 64 MB are rejected) on the endpoints that report holding it. It is accepted when its
  transaction hashes rebuild the agreed merkle root (SHA3-256, leaf `0x00 || hash`, node
  `0x01 || left || right`, odd node duplicated) and `n - quorum + 1` endpoints serve identical rows. An
  endpoint whose body fails the root is quarantined for 30 minutes, or takes a 15 s cooldown when
  quarantining it would leave fewer than a quorum admitted. The row's hash, previous hash, merkle
  root, producer and agreed time come from the header; the body supplies the transactions.
- **Realtime.** One WebSocket at a time on `/ws/subscribe?channels=blocks` (the HTTP URL with
  `http`/`https` rewritten to `ws`/`wss`); a `NewBlock` event schedules the quorum read of its height.
  Reconnection backs off from 1 s to 30 s, and a socket that delivers no tip block for 45 s, or more
  than 500 events a second, is dropped so the subscription rotates to the next endpoint.
- **Network height.** `GET /api/v1/height` is asked of every healthy endpoint every 2 s while the
  socket is down, every 10 s while it is up but silent and every 30 s while blocks arrive. The network
  height is the quorum-th highest answer, and a single source may lead it by at most 600 blocks.
- **Gaps.** `sync_state.last_height` is the highest stored block and `indexed_prefix` the last height
  below the first hole; every hole is a `sync_gaps` range. Each second the catch-up claims the lowest
  due range and the highest due range inside the body retention window, ingests up to 1,000 heights
  of it in commits of at most 200 blocks or 150,000 estimated recipient rows, and requeues what is
  still missing with a backoff of `min(600, 15 × 2^min(tries, 6))` seconds.
- **Pruned bodies.** Nodes keep block bodies for `MICROBLOCK_BODY_RETENTION_BLOCKS` = 86,400 blocks. A
  height whose body the network has pruned is stored as an identity-only row
  (`body_indexed = FALSE`). Its time is the agreed header's; where the header carries none, below
  `SLOT_GAP_REANCHOR_GATE_HEIGHT` = 1,339,200 it is the slot time, the quorum-agreed time of block 0
  plus one second per height, and from that height on a lower bound from the nearest stored row below
  it. A stored body stays when a header calls its height empty. Nodes started with `QNET_ARCHIVE=1` keep
  archived bodies past that window and report them as `body: true`; the indexer asks `GET /api/v1/archive`
  where each endpoint's archive starts and treats heights at or above the `n - quorum + 1`-th lowest start as still
  obtainable: a missing body there is retried, not recorded as pruned.
- **Token transfers.** After blocks with transactions are stored, the node's `/api/v1/token-transfers`
  rows for that height range are fetched from the endpoints that served the agreed bodies, and each
  window of up to 10,000 heights is replaced when `n - quorum + 1` of them return identical rows.
- **Reorgs.** The `previous_hash` linkage with the stored neighbours is checked after every commit,
  and every 10 minutes up to 32 random stored heights are compared with the quorum's hashes. Where a
  quorum names another block at a stored height, the contradicted run is walked up to 1,000 heights
  each way: every row the quorum contradicts is deleted and queued for refill, and the walk stops at
  the first row it confirms or cannot decide. A quorum naming another block at the archive's anchor
  (block 1, re-asked every 30 minutes and before every repair) is a fresh genesis: the archive is
  truncated and rebuilt, and the dissenting endpoints are quarantined. Twenty consecutive header pages
  on which the endpoints agree on nothing halt ingestion; the next page they agree on lifts the halt.
- **Heal.** Every minute, or 10 minutes after a pass that finds or changes nothing, rows without a real
  hash, bodies inside the retention window whose transaction rows fall short of
  `tx_count - tx_skipped`, and identity-only rows back inside the window or at or above the archive reach are
  re-read through the same quorum path.

## Database schema

The first three migrations create seven tables, `004_address_history.sql` adds the
`(from_address, block DESC, tx_index DESC)` and `(to_address, block DESC, tx_index DESC)` indexes of the history feed,
and `005_cabinet_activations.sql` adds `cabinet_activations`, the node cabinet's activation registry (`006` its index on
`reservation`); the runner adds
`schema_migrations`, its ledger of applied files.

| Table | Key | Contents |
| --- | --- | --- |
| `blocks` | `height` | hash, `block_type`, version, timestamp, previous/merkle/state roots, producer and producer address, tx count, `tx_skipped`, `body_indexed`, gas used, signature and `signature_type`, size, `consensus_data` JSONB, `micro_blocks` array |
| `transactions` | `hash` | from/to, amount, nonce, block and `tx_index`, timestamp, gas price and limit, signature and public key, `tx_type` and `tx_type_data` JSONB, raw `data`, status |
| `batch_transfers` | `(tx_hash, tx_index)` | one row per recipient of a `BatchTransfers` envelope: block, timestamp, from/to, amount |
| `token_transfers` | `(tx_hash, log_index)` | contract, from/to, `amount` as `NUMERIC(80,0)`, `kind`, `std`, `token_id`, block, timestamp |
| `explorer_stats` | single row, `id = 1` | transaction totals overall and per type, block and batch-recipient totals, emission total, head height, hash and time |
| `sync_state` | single row, `id = 1` | `last_height`, `indexed_prefix`, `genesis_hash`, and the node height, subscription state, endpoint and heal backlog the indexer publishes every 5 s |
| `sync_gaps` | `start_h` | height ranges still to fetch, with a try count and the next retry time |
| `cabinet_activations` | `wallet` | one QNet wallet's activation: `state` (`reserved`, `sending`, `recorded`), `node_type`, `way` (`extension` or `payment`), `burner`, `burn_amount`, the reservation and its times, `burn_tx` (unique), `burn_slot`, the burn's and the record's times, and the proof (JSONB: the wallet's signed reservation, then the extension's burn proof, or for a payment burn the signed reservation with the payment key's owner bind); no IP address |

`tx_skipped` counts the transactions of a block that have no row of their own: genesis prefund
transfers, transactions from or to `EON1benchmark` accounts, transactions whose hash or addresses fail
the column checks, and a hash stored earlier in the block or under another block. `explorer_stats`
moves inside every commit by what the inserts reported as new minus what the deletes removed. A full
rebuild runs when `rebuilt_at` is null; a daily audit compares the counters with real counts and
clears `rebuilt_at` on a mismatch, so the next start rebuilds them.

Amounts and nonces use exact integer types, never floats: `amount`, `nonce`, `gas_price` and
`gas_limit` in `transactions`, and `batch_transfers.amount`, are `NUMERIC(20,0)` and hold the full u64
range; `blocks.total_gas_used` is `NUMERIC(30,0)`. The transaction list pages by keyset on
`(block, tx_index)` over `(block DESC, tx_index DESC)` indexes, and the address and contract indexes
on `token_transfers` carry `(block DESC, log_index DESC)`, so an address or token page is an
index-ordered scan bounded near the query limit.

## HTTP API routes

All under `/api` on the explorer itself (not the node). Read routes are rate-limited per client
identifier, each route in a bucket of its own; `/api/activity`, for example, allows 600 requests per
minute per client. Every per-IP limit keys on `X-Real-IP`, which nginx on the same host sets to the
connecting address (`lib/rate-limit.ts`); a client's `X-Forwarded-For` is never read, a request without
`X-Real-IP` (one that did not pass nginx) is keyed on its socket address, and an IPv6 address counts as
its /64. The app listens on `127.0.0.1` only (`npm start` is `next start -H 127.0.0.1`), so no client
can reach it without passing nginx. A limiter holds a bounded number of keys and, when full, evicts the
key whose window started first instead of refusing new ones; the QNet Link relay has a limiter of its
own, so explorer traffic never crowds it out.

| Route | Purpose |
| --- | --- |
| `GET /api/activity` | Transaction list from the index, enriched for display: keyset pages by `cursor` and `dir`, numbered `page` jumps up to 200, a `types` filter; the default first page comes from the head snapshot |
| `GET /api/address/[address]` | Address summary and history, with incoming `BatchTransfers` credits merged in |
| `GET /api/address/[address]/history?cursor=&limit=` | The wallet's history feed: transactions sent or received, batch credits and token transfers as one newest-first list, `limit` 1–100 (default 50), ordered by block, source, position and hash, paged by the returned `next_cursor`. Amounts are raw (nano QNC or token base units, with the token's deploy-time symbol, decimals and logo); `fee` is the nano QNC the chain debited a sender |
| `GET /api/address/[address]/balance-proof` | The balance verified against a committee certificate (Balance check, below) |
| `GET /api/blocks/[hash]` | Block by hash |
| `GET /api/tx/[hash]` | Transaction by hash; a `BatchTransfers` envelope carries its recipients |
| `GET /api/tokens`, `GET /api/token/[contract]`, `GET /api/token/[contract]/holders` | Token list, token detail, holders |
| `GET /api/token/[contract]/logo` | The token's on-chain logo, fetched by the server (`src/server/logo-proxy.ts`) from the URL the nodes report for the contract: https on port 443 only, no host that resolves to a private, loopback, link-local, shared, documentation, multicast or reserved address (the connection goes to the address checked), no redirects, at most 256 KB in 5 s, a PNG, JPEG, WebP or GIF by its own bytes (never SVG), nothing of the visitor passed on. Kept in memory (6 h, a missing logo 10 min; at most 2,000 logos and 32 MB), at most 4 fetches at once; 404 when there is no usable logo, 503 while busy; 600 requests per minute per client |
| `GET /api/qnc` | Native QNC rich list, proxied from the node's `/api/v1/richlist`; the genesis-funded load-test accounts come apart as `genesis_allocations` and the QNC page shows them on one line instead of among holders. `GET /api/address/[address]` sets `genesisAllocation` for such an account and the address page says so |
| `GET /api/network/stats` | Head, totals and emission from the head snapshot, plus Super nodes (distinct `Heartbeat` senders in the last complete 14,400-block epoch) and Light nodes (the largest per-epoch sum of bitmap `eligible_count` over the last three complete epochs), cached 60 s |
| `GET /api/search`, `GET /api/search/suggest` | Search and type-ahead |
| `POST /api/faucet/claim` | Testnet faucet dispatch (see Faucet) |
| `POST /api/faucet/pass` | The faucet pass for the QNet wallet the node cabinet activates (see Faucet) |
| `GET /api/head` | The head snapshot as JSON, the poll fallback for `/api/stream` |
| `GET /api/stream` | Server-sent `head` event on each new head snapshot; at most 6 streams per client, 15 s heartbeat |
| `GET /api/sync/start` | The indexer's published state: head, prefix, node height, lag, subscription, heal backlog, and `healthy` when the lag is at most 600 blocks and the last commit is under 120 s old; `POST` answers 410 |
| `GET /api/monitoring/health`, `GET /api/monitoring/alerts` | Health (database, indexer lag and freshness, monitoring) and alerting; health reports `degraded` when the last commit is over 120 s old or the lag exceeds 600 blocks |
| `GET /api/activation/price?type=light\|super` | The activation price from the pinned nodes `https://node1..5.aiqnet.io` (`/api/v1/activation/price`): `{type, phase: 1, cost, currency: '1DEV'}` or `{type, phase: 2}`, 503 when no node gives a valid quote (no fallback numbers); cached 15 s. A node's answer is read as a stream and dropped past 8 KiB (a larger declared length is not read at all), 4 s per node |
| `POST /api/link/sessions`, `GET /api/link/sessions/[id]`, `GET`/`POST /api/link/sessions/[id]/response` | The QNet Link relay (`src/server/link-relay.ts`, protocol sections 5 and 14.5): the intents `connect`, `link`, `claim`, `reserve` and `unlink` (an `activate` session is refused), a session of any of them but `connect` with its request and the request's hash, which the relay computes; sessions in process memory (at most 100,000, at most 60 per creating IP, of them at most 5,000 `link` sessions and 10 per creating IP, 600 s each), one encrypted answer per session, body caps per intent (a `link` answer up to 12,288 bytes, the others 4,096), per-IP limits with a limiter store of its own (120 creates per 10 min; 120, 60 and 600 per minute for the other routes, for many phones or computers behind one NAT address), foreign `Origin` refused, and any `Sec-Fetch-Site` but `same-origin` (a browser request another page made, a GET by `<img>` included) refused before a limit counts it, in the app and in nginx, whose relay location has a rate-limit zone of its own; nothing logged by the relay or by nginx (`access_log off` for `/api/link/`) |
| `GET /api/cabinet/node/[id]`, `GET /api/cabinet/node/[id]/history` | The node cabinet's reads of a node (`src/server/cabinet/node-proxy.ts`), the status for a light node id only, the history for a light or a super node id: the public status from two genesis nodes `https://node1..5.aiqnet.io`, asked in the order of the node's light shard (the genesis that wakes its device, then the shard's two other owners, then the other two genesis nodes, each group shuffled), which must agree whether the node is registered (503 otherwise), with the features both list, the node balance and the linked device (`device`: `{platform, model, linkedSince, lastAnswerEpoch, state, lastMiss}`, the first five from the first settling answer, or null; a node's malformed `device` refuses its answer, one without the field names none, and a field of it the site does not read is ignored). `answeredThisEpoch` and `needsReactivation` are the word of the shard's owners that list the node (those at the network's height when any is, a node behind reading an older epoch; with no owner's answer, the settling pair's): answered when any of them says so, needs reactivation only when every one of them does, since an answer reaches the other owners by one relay that an owner down or restarting misses; when that word differs from the first answer's own, the device's `state` follows it by the node's rule (Online unless the node needs reactivation; then an owner's Offline or new-device state), and `lastAnswerEpoch` is the latest those owners name. `lastMiss` (`{epoch, reason, delivered}`: whether the wake of that epoch reached the device by the device's own account, true, false, or null when not known) is the shard owners' `device.last_miss` ([light node messages](../protocols/light-node-messages.md) section 7) as a reader takes it: among the answers, the miss of the highest epoch, at equal epochs the most specific reason (`not_committed`: no committed check of the shard, so no node of it counted whatever the device did; `answered_late`, `not_delivered`, `answer_refused`, `woken_no_answer`, `no_push_address`; `not_sent`: a wake the network did not get out, below any record of an owner that reached the device; `not_woken_inactive`), at equal reasons the one that knows whether the wake reached the device (the owner that took the device's account of it); a reason the site does not know, or a record it cannot read, is passed over, and a node without the field gives null. The keyless status names no exact time, delay or app outcome; a node of an earlier version that still sends them (`last_answer_at`, `last_answer`, a miss's times, delay, refusal code and `app_outcome`) is read for whether the wake reached the device alone, and nothing else of it is kept, neither in the answer nor in the shared per-node cache. When the answers name a miss newer than the node's last counted epoch with no later answer (but a shard with no committed check, the same at every owner), or a wake with no answer whose record lacks the device's account (only the owner that took the device's next answer keeps it), or the owners asked call the device Offline, a page's read also asks the shard's owners not asked yet, once (a reservation's read does not); and the node's epochs one by one from its registration on (up to 4 pages of 100 a node reports, the older pages only for a node that names the wallet the id derives from, a second node filling the ones the first could not serve): counted and still in the node balance, moved to the wallet, missed, the registration's own epoch, not checked by the network, or not readable, with the explorer archive's facts (`src/server/cabinet/epoch-archive.ts`: the registration's epoch, each epoch's end time, and the transaction that moved it to the wallet) and the older epochs the archive knows only as moved; without the archive the epochs come undated. Exact answer shapes, cached per node 25 s, about the page's poll interval (a settled "not registered, not being recorded" 30 s; history 30 s), one upstream round per node at a time, 4 s and 64 KiB per node answer; foreign `Origin` and any `Sec-Fetch-Site` but `same-origin` refused before a limit counts it, then 120 requests per minute per client with a limiter store of the cabinet's own, and apart from it 30 reads a minute per client that miss the cache and go to the genesis nodes, shared with the super node and wallet-node routes (`limits.ts` `CLIENT_BUDGETS.upstreamMiss`, 429 past it). Each genesis node is asked at most 16 of these reads a second for ids the site has seen the network list as registered (kept in process memory a day after it was last seen registered, with nothing of who read it, `src/server/cabinet/known-nodes.ts`) and 4 for any other id (`upstream.ts` `readKnown`, `readUnknown`), so made-up ids, which cost nothing, cannot starve the owners of registered nodes |
| `GET /api/cabinet/super/[id]` | A super node's status (`node-proxy.ts` `superStatus`), for a super node id (`super_node_` and 16 hex, or a genesis node's): `{registered, online, lastSeenAt, heartbeats, banned, balanceNano}` from the genesis nodes' `/api/v1/node/status` (one node that lists it registered answers "yes", two that do not are needed for "no"), the balance from `/api/v1/rewards/pending`, and when the nodes know no last-seen time the archive's newest heartbeat of the node; cached 25 s ("not registered" 30 s), 120 per client per minute, its reads that go upstream on the client's and the genesis nodes' read budgets as the light status's |
| `GET /api/cabinet/wallet-node/[wallet]` | Whether a wallet has a node of either type (`src/server/cabinet/wallet-node.ts`): the genesis nodes' `/api/v1/verify-activation` with the wallet in the `x-qnet-wallet` header, two first then one more at a time (any `verified: true` is a node; a "no" needs a node at the network's height), then the light node's settled status: `{"state":"registered","nodeId","nodeType"}`, `{"state":"none"}`, or 503; cached 25 s (`none` 30 s), 60 per client per minute, its reads that go upstream on the client's and the genesis nodes' read budgets as the light status's (the budget of known ids for a wallet whose node was seen registered). A reservation (below) asks the same with a 5 s cache and an upstream budget of its own (`src/server/cabinet/upstream.ts` `reserve`, 10 calls a second per genesis node beside the reads' 16 and 4), so no flood of anonymous reads makes it answer `network_unavailable` |
| `GET /api/cabinet/price`, `GET /api/cabinet/payment/[address]`, `GET /api/cabinet/blockhash`, `GET /api/cabinet/tx/[sig]`, `POST /api/cabinet/send` | The activation's Solana side (`src/server/cabinet/solana-proxy.ts`): the light price two genesis nodes agree on (15 s), a payment address's SOL and 1DEV (3 s), the latest blockhash (2 s), a transaction's state and the light burn it holds (its status by signature 2 s, the block height, one for all, 2 s, and a finalized transaction's burn a day, since it never changes; the state that depends on the page's `lvh`, pending or expired, is worked out from them on the server, so a new `lvh` costs no Solana read). A page reads its own burn and refund with the read pass `send` gave for that signature; those reads that go to Solana share 10 a second for the whole server, and reads of any other signature 2 a second, each client at most 12 a minute of them; past either the route answers 503 without asking Solana; `send` forwards only the cabinet's burn or refund, validly signed by its payment address (`src/lib/cabinet/burn-tx.ts`), anything else 400: a burn only as exactly `{"tx","reservation","ownerSig"}`, announced under that reservation in the activation registry before it leaves (the reservation's payer and whole amount must be the burn's; 409 `{"error":"reservation"}` and nothing forwarded otherwise), with the payment key's owner bind v2 of the reserved wallet's light node, 128 hex, which must verify against the key of the wallet's signed reservation (400 `{"error":"invalid_proof"}` and nothing forwarded otherwise); a refund exactly `{"tx"}`. A burn sent earns its read pass; a refund only when its payer is a payment address a reservation of this site named (`007_cabinet_activations_burner.sql` indexes them), since any funded key can send one. Per client 60, 120, 60, 120 and 10 per minute; `send` also 5 per payment address per 10 min |
| `POST /api/cabinet/register` | The registration of a light burn from any browser (`src/server/cabinet/register.ts`), in one of two bodies. A payment address's burn: exactly the wallet's consent (`from`, `node_id`, `node_type`, `wallet_address`, `registration_proof`, `timestamp`, `burn_tx_hash`, `burn_amount`, `dilithium_signature`, `dilithium_public_key`), checked as the node checks it; then the wallet's row in the activation registry: its own payment burn, recorded, of this burn and amount, whose signed reservation carries this very wallet key; the body completed with that burn's payment address (`burn_wallet`) and the owner bind v2 the row keeps (`owner_signature`), which is verified again. A burn made from the wallet's own Solana address: the consent with `burn_wallet` (that address) and `owner_signature`, its owner bind v1 at the consent's `timestamp` (128 hex, which QNet Wallet signed with the wallet's Solana key), in the node's field order, checked as the node checks it (400 `invalid_request` with the field otherwise); then the wallet's row when it has a burn (that very burn, of that burner, a light one of this amount, recorded), else the search of `burn_wallet` (the kept one of the activation reads, in the reservation's lane, a new one charged to the register client and to the node, each its share of the lane: its first burn must be this light burn of this amount; `scan_incomplete` is a retry); then the network's one-node rule (the wallet's own light node already listed answers `registered`, any other node `wallet_has_node`, a network that cannot answer a retry). Either is then sent to one genesis node, one submit in flight per node; 30 per client per 10 min and 6 per node. Nothing is relayed for a burn not final yet (`{"result":"retry","code":"not_final"}`), another burn (`other_burn`), no such burn of the wallet or burner (`no_record`), another amount or node type (`invalid_burn`) or a key, bind or burner that does not match (`owner_bind`); the node's `wallet_has_node` (one wallet, one node) comes back refused |
| `GET /api/cabinet/registration/[wallet]` | The block, burn, burner and amount of a wallet's light node registration from the archive, or with `?type=super` of its super node's (the row sent from its super node id), for Node details (30 s cache, 30 per client per minute): exactly `{"found","record":{"height","burnTx","burner","amount"},"burnBy"}` or `{"found":false}`. `burnBy` says whose burn it is, so the page shows one code: `payment` (a one-time payment address of the site: the wallet's code) or `own` (the wallet's own Solana address: the burner's code; always so for a super node). For a light node: the wallet's row in the activation registry that holds this burn names it (`payment` for a payment address's, `own` for the extension's); without one no payment key of the site made it (every payment address's burn is announced in the registry before it leaves), and it is `own` once Solana holds that burn final and valid with the archive's burner as its fee payer and burn authority. Kept 24 hours per registration once known, and `null` as long when Solana holds that burn failed, or final but not as that burner's own valid burn; the Solana checks share 30 a minute for the whole server; `null` while the registry or Solana cannot tell |
| `GET /api/cabinet/activation/[wallet]`, `POST /api/cabinet/activation/reserve`, `…/announce`, `…/release`, `…/record` | The activation registry (below) |
| `POST /api/cabinet/wake` | "I'm back" (`src/server/cabinet/wake.ts`): exactly `{"nodeId": N}`; the owners of the node's light shard in rank order (the genesis that wakes its device, then its two backups), each asked `{"node_id": N}` at its `/api/v1/light-node/wake` only when the one before gave no answer (not reached, not 200, as from an owner behind the network, which answers 503, or no reply the site reads), 8 s for the first and 4 s more for each owner above the one asked, which hands the wake to those first (2 s each for one it cannot reach), all within 40 s; 503 when none answers. The node's reply is read as its route writes it, `{"success", "reason", "node_id"[, "retry_after_seconds"]}`: `reason` one of `sent`, `already_answered`, `no_device`, `not_registered`, `cooldown`, `success` true for `sent` alone, `node_id` the node asked about, and a `cooldown`'s wait in whole seconds up to a day; anything else is no answer. The site answers `{"result": R}`, for a `cooldown` with a known wait `{"result": "cooldown", "retryAfterSeconds": s}`, and the page says when to try again in minutes. A push the network sent holds the node for 10 min and a `cooldown`'s wait for that long: within it the site answers `cooldown` with the wait left without asking the network; an answer that sent nothing holds nothing. 3 per client and 1 per node per 10 min. `no_device` also covers a device the device layer would not push (paused, past its lease or overdue for its key rotation): that rule is the node's (`device_layer_pushable`) and stays as it is while the layer is off on the network and the sandbox; whether to wake those states is the owner's decision for when it is turned on |

Every `/api/cabinet/` route writes nothing of its requests to a log, and nginx gives it a location of its own
with `access_log off`, the same `Sec-Fetch-Site` refusal as the relay and a rate-limit zone of its own
(`aiqnet_cabinet`).

### Activation registry

One wallet gets one activation: one burn and one code, for a light node or a super node, chosen once
([node activation](../economics/node-activation.md#one-wallet-one-code)). The site keeps one row per QNet wallet in
`cabinet_activations` (`005_cabinet_activations.sql`; `src/server/cabinet/activation-registry.ts`, whose every step is
one statement that compares and sets, and `activation-api.ts`), so every browser, device and client sees the same and
two of them cannot both burn for one wallet. The routes answer JSON with `Cache-Control: no-store`; they take no
`Origin`, `https://aiqnet.io` or any browser extension's `chrome-extension://<id>` (the QNet extension's among them), and no `Sec-Fetch-Site`,
`same-origin` or `none` (anything else 403 `forbidden_origin`); per client 60 reads a minute, 10 reads with `?solana=`
per 10 min, 20 writes per 10 min, and 10 records per wallet per 10 min once their proof verified; 429
carries `Retry-After`.

| Route | What it does |
| --- | --- |
| `GET /api/cabinet/activation/[wallet][?solana=S]` | The wallet's row: exactly `wallet`, `state` (`none`, `reserved`, `sending`, `recorded`), `nodeType`, `way`, `burner`, `burnTx`, `burnAmount`, `code` (only when recorded), `until` (a reservation's end, an announced burn's last moment to land) and `recordedAt`, and with `?solana=` while the state is `none` the search of that Solana address: its signatures in pages of 1,000, older pages with `before`, up to 4 pages; those with a `QNET_NODE_TYPE` memo read oldest first, at most 30, and only the ones S paid for count toward the 10 of its own (a memo transaction someone else sent it costs a read, never that cap); `{complete, unusable, burns}`, complete only when every page and every marked transaction was read (`unusable`: a 1DEV burn of S's own no code comes from; a transaction that burned no 1DEV is no burn, whatever its memo), kept 5 minutes per address. Each of two lanes, these anonymous reads and the signed requests (a reservation's search and an own-address registration's), which the reads cannot starve, has budgets of its own for the whole server: 120 first pages of signatures a minute, and 30 searches a minute that read further pages or the marked transactions, so an address with no activation memo (a throwaway one) takes nothing scarce. A new search is charged first to the clients the route names (the visitor's IP, IPv6 by its /64, and for a registration also the node), each at most 3 searches a minute in a lane and 1 of them past its first page, so many free QNet wallets from a few addresses cannot drain a lane; a search that joins one in flight costs nothing, and both lanes share the kept results. A search that cannot finish offers no burn; the QNet extension's own search, which continues where it stopped ("Recover my code"), is the way on for such a wallet. A `sending` row is settled first: landed, final and valid, it is recorded, whichever way (its proof came with the announce); failed, or not found 10 minutes after the announce, the row goes |
| `POST /api/cabinet/activation/reserve` | Exactly `{wallet, nodeType, way, burner, burnAmount, solana, proof}`, at most 12 KiB (the payment way is light only, the extension's burner is its own Solana address). `proof` is the wallet's signed reservation `{pk, sig, time}`: its ML-DSA-65 key (base64url) must give the wallet, and its signature (FIPS 204 context `QNET_OFFCHAIN_MSG_v1`, over the envelope the wallets build for `https://aiqnet.io`) must verify over `QNet node reservation v1` with these very fields and `time` (400 `invalid_proof`); `time` must be at most 10 minutes old for the extension, 24 hours and 10 minutes for a payment address (QNet Wallet signs it before the address exists), and at most 5 minutes ahead (400 `stale_proof`). Then the wallet's row, then the network (409 `has_node` for a node of either type, 503 `network_unavailable`), then for the payment way a search of the wallet's Solana address no older than 5 minutes: the signed reservation does not name that address, so the page's own recent finished search of it answers, and a new one is charged to the client as above (409 `burn_found` or `burn_unusable`, 503 `scan_incomplete`), then one statement that takes a free row or an expired reservation, keeping the proof: `{reservation, until}` for 10 minutes, or 409 `has_burn`, `burn_pending` or `reserved` with the row |
| `POST /api/cabinet/activation/announce` | The extension's burn under its reservation, with the proof made with the wallet's own keys (`src/lib/cabinet/burn-record.ts`: the wallet's ML-DSA-65 signature, FIPS 204 context `QNET_OFFCHAIN_MSG_v1`, and the burner's Ed25519 signature over one message naming the wallet, the node type, the burner, the burn and the amount): `sending`, or 409 `reservation`, 400 `invalid_proof` |
| `POST /api/cabinet/activation/release` | A reservation without a burn given up (a burn is never released); always `{"ok":true}` |
| `POST /api/cabinet/activation/record` | The extension's final burn with that proof: recorded once Solana holds it final and valid (409 `not_final`, 400 `invalid_burn`), over no row, a reservation without a burn, or the same burn on its way; over another proven burn (a payment address's included) only when it is the same burner's older burn; otherwise 409 `other_burn` |

A payment key's burn is announced by `POST /api/cabinet/send` with its owner bind and is recorded as soon as it is
final, exactly like an extension burn; `POST /api/cabinet/register` only reads the record (and, for a burn of the
wallet's own Solana address that the record does not hold, the search of that address). A reservation without a
burn goes an hour after it ended (a sweep at most every 10 minutes per process); a record stays while the cabinet
runs, since a burn is public and permanent. No IP address is stored. Deploy the site after the indexer has applied `005_cabinet_activations.sql`: until
the table exists (or while the database cannot be reached) every activation route answers 503 `unavailable`, the
pages name the check that did not answer, and nothing is burned. When the web tier connects as a read-only role of
another name than `explorer_reader`, grant it `SELECT, INSERT, UPDATE, DELETE` on `cabinet_activations` by hand.

### Balance check

`/api/address/[address]/balance-proof` (`src/server/light/balance-proof.ts`) answers with an address's balance only
once it is verified against the network's committee certificate. It asks the pinned genesis nodes
(`src/lib/genesis-nodes.ts`), in a random order, for the certified proof
(`GET /api/v1/account/{address}/balance/proof?mb=latest`, [RPC API](../developers/rpc-api.md)): the node names a
certified macroblock, and the proof (inclusion, absence, or absence in a shared bucket with every entry of the bucket, over every
field of the account leaf) must fold to that macroblock's state root as the site's own light client verified it
(`src/server/light/lineage.ts`), never to the root the node served. The light client walks the macroblocks' committee
certificates up from the wallets' release pin (`src/server/light/pin.ts`, the block kept identical to the mobile
wallet's `genesisConsensus.js`; the site proves no state at or below the pinned macroblock): each committee is drawn
from the eligible set and beacon of the macroblock two below, its keys are bound to that macroblock's registry root,
and a strict quorum of distinct valid ML-DSA-65 signatures is required. It keeps the newest verified macroblocks in
memory, runs one walk per parity chain at a time for every request, reads at most 180 times a minute from each node,
and starts again from the pin when the server restarts. The macroblock must also be recent: at most two below the
certified head, the second highest `newest_certified_index` of at least three genesis nodes'
`GET /api/v1/state/certified` (from nodes that predate that route, the second highest of the macroblocks at least three of
their heights fall in), read once a minute. A node that predates the certified form answers the legacy proof against its live root; that
counts only for a plain account whose live root is the certified root of the macroblock covering the node's height or
one of the two before it, and such a node is asked last for the next ten minutes. An answer without a proof that folds
(a legacy "account not found" among them), an error, a rate limit or a timeout is no answer, and the next node is asked.
The route answers `{"verified": true, "exists", "balance", "balanceNano", "nonce", "macroblockIndex", "stateHeight",
"stateRoot", "verificationMethod": "committee-certificate"}`, or `{"verified": false, "reason", "error"}` with no
figure: `not_confirmed_yet` while the light client is still walking to the macroblock or no recent certified proof
could be had, `network_unavailable` when no node gave an answer or no head could be read. A request waits at most 6 s
for the walk, which goes on after it. Results are cached per address, 30 s when verified and 5 s otherwise, and each IP
may ask 120 times a minute; a request for an address whose check is already running waits for that check. The address
page's Verify Balance, which shows the proven balance with its checkpoint, the block its state is at and the state root,
is hidden at present.

### Faucet

The site has one faucet, the `/testnet` page's, and it sends test tokens to the Solana address the user enters; no
route sends a payment address of My node anything, since the user funds it from their own wallet. The page, its header
tab and its sitemap entry exist on a testnet release only (the activation network of `src/lib/one-dev.ts`); on a
mainnet release `/testnet` is not found. The claim route
signs with `FAUCET_PRIVATE_KEY`, which is read at runtime and must be present for the
route to serve. It accepts a POST only without an `Origin` header (a script or the SDK) or with
`https://aiqnet.io` as its origin, without a `Sec-Fetch-Site` header or with `same-origin`, only as
`application/json` (415 otherwise) and at most 1 KB, so a third-party page cannot send claims with its
visitors' IP addresses. The 1DEV and SOL transfers are
legacy Solana transactions that `src/server/solana-tx.ts` builds and signs with the key (Ed25519 from
`@noble/curves`), byte-for-byte what `@solana/web3.js` and `@solana/spl-token` built (the tests hold
vectors made by them), and that `src/server/solana-rpc.ts` sends and confirms over JSON-RPC; no Solana
SDK runs in the process that holds the key. A claim asks for one token: at most 1500 1DEV or 0.01 SOL; the
`/testnet` page asks for 1,500 1DEV and 0.005 SOL as a pair, enough for a wallet to send the activation's 1DEV and
SOL to a payment address of My node, whose card links the page and hands over the wallet's Solana address (read once
from the tab's session storage, never from the URL). The faucet sends test tokens only: on a release whose network is
not testnet (from `BURN_CLUSTER` in `src/lib/qnet-link.ts`, never a setting) the route answers 404. Every claim passes
the same admission (`src/server/faucet-guard.ts`): one claim of each token per address a day, keyed on the
`(address, token type)` pair so the page's pair never refuses itself; 5 claims of each token per client IP an hour and
15 per network block (an IPv4 /24, an IPv6 /48); and 30 claims of each token an hour for everyone, of which 24 are kept
for claims that carry a faucet pass at the start of the hour and 6 are open to any claim. The kept places are kept pro
rata through the hour: those that claims with a pass have not taken by their share of the hour so far open to any claim
(half an hour with no claim with a pass opens 12 of them), so the hour is not lost while no one activates, and a claim
with a pass later in the hour still finds its part; a claim with a pass may take any free place. A faucet pass is asked
for by the node cabinet's payment card with the wallet's signed reservation it holds (`POST /api/faucet/pass`, exactly
`{wallet, burner, proof}`: the reservation must verify for that wallet and payment address and be within the payment
way's window, 400 `invalid_proof` or `stale_proof` otherwise; 10 requests per client per 10 min; once the reservation
verified, 3 passes an hour per client IP and 10 per network block, since a QNet wallet costs nothing and these are what
make a pass scarce; 429 with `retryAfterS` past either; 404 off testnet) and handed to the Testnet page with the
address; it names the wallet and the second it
ends, an hour later, with an HMAC of both under `FAUCET_PASS_KEY` (`src/server/faucet-pass.ts`, compared in constant
time; the server keeps no list of passes). With a pass each wallet gets one claim of each token a day, whatever address
it names; a pass that does not check out, or has ended, makes the claim an open one. A refusal carries `retryAfterS`
(and `Retry-After`), or `nextClaimTime` for an address or wallet that had its tokens today, and the page says when to
try again ("Try again at 14:05."). The places are taken before the transaction is dispatched and released again only
when the send definitively cannot have landed. The cooldowns live in process memory only
(`src/server/faucet-cooldown.ts`): an entry is dropped once its 24 hours have passed (on access and by a sweep every
minute), and at most 100,000 are held, a full store evicting the claim made longest ago; the privacy policy states
this.

## Environment variables

Values are operator-supplied. Never commit them; never place them in a document.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Connection fields for `scripts/backfill-timestamps.ts` |
| `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED` | TLS for the database connection |
| `QNET_API_URL` | Single node URL, used when `QNET_API_URLS` is unset |
| `QNET_API_URLS` | Comma-separated node URLs: the indexer reads and votes over them; the API routes ask them in turn |
| `QNET_BOOTSTRAP_NODES` | Comma-separated node list used for validator discovery |
| `SOLANA_RPC_URL` | The Solana devnet RPC endpoint of the site's server, for the node cabinet's reads, sends and burn searches and for the faucet: an https URL without user info (plain http only for a node on this machine). Unset, it is the public `https://api.devnet.solana.com`, which allows one address only a few requests a second (`src/server/solana-endpoint.ts`); the deploy scripts warn when it is missing |
| `DAO_ENABLED` | `1` opens `POST /api/dao/vote`; any other value, or none, refuses every vote |
| `QNET_API_KEY` | Sent as `X-API-Key` to the node to bypass its rate limits |
| `FAUCET_PRIVATE_KEY` | Faucet signing key, read only at runtime |
| `CABINET_READ_KEY` | 32 bytes or more in hex (`deploy-aiqnet.sh` makes it once and keeps it): the key of the read passes the cabinet's send route gives for a burn or refund, so they outlive a restart; unset, a key of the process |
| `FAUCET_PASS_KEY` | 32 bytes or more in hex (`openssl rand -hex 32`, set once in `.env.local`; `deploy-aiqnet.sh` makes it once and keeps it): the key of the faucet passes `POST /api/faucet/pass` gives, so they outlive a restart; unset, a key of the process, and a restart ends the passes it gave (a claim then takes the open share) |
| `CABINET_PHONE_FLOWS` | `1` lets the node cabinet send QNet Wallet its `link` and `claim` requests; any other value, or none, is off (the deploy scripts write `0`) |
| `WALLET_APK_URL` | The https address of an `.apk` file: QNet Wallet's Android file, the same Play-signed build as Google Play, which `/wallet` then offers; unset offers none. The file is served from aiqnet.io, or is the asset of one fixed GitHub release, `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>` (for example the tag `app-1.3.0-20`), whose tag does not match `wallet-<x.y.z>-<n>` and whose asset is not named `QNet-Wallet.apk`: that tag pattern and that asset name belong to the older Android build's move release, which the 1.1.7 site APK's update check takes ([mobile wallet](mobile-wallet.md)). A `.../releases/latest/...` address, which could resolve to that release, and a release file with that tag pattern or asset name are refused (`src/server/wallet-apk.ts`), and the page then offers no file |
| `SECURITY_WEBHOOK_URL` | Destination for security and alert events |
| `INDEXER_LOG_LEVEL` | Indexer log level: `err`, `warn` or `info` (the default) |
| `NODE_ENV` | Standard Next.js environment selector |

The API routes read the node through `src/lib/node-api.ts`: each read goes to the first node in the list that is
not cooling down, and a transport failure, timeout or 5xx moves it to the next and benches the failed node for
15 s, so one node restarting in a roll or saturated by a load test does not take balances and lookups with it. A
swap submission is a write and goes to one node only. A production build keeps only http(s) URLs with a publicly
routable host (a loopback, private, link-local or CGNAT host is dropped); with none left `/api/tx/[hash]` answers
503 naming the misconfiguration. Outside production an empty list falls back to `http://127.0.0.1:8001`. The
indexer accepts any http(s) URL in `QNET_API_URLS`.

## Running locally

Requires Node.js 22 or later and a reachable PostgreSQL instance. Set the environment first — at minimum
`DATABASE_URL`, plus `QNET_API_URLS` (or `QNET_API_URL`) for the nodes to index.

```bash
cd applications/qnet-explorer/frontend
npm install
npm run dev               # next dev, bound to 0.0.0.0
```

The indexer runs beside the web tier from the same directory and applies the migrations when it
starts; start it before a web tier that needs a new table (the activation routes answer 503 until
`005_cabinet_activations.sql` is applied):

```bash
npm run build:indexer     # tsc -p tsconfig.indexer.json into dist-indexer/
npm run start:indexer     # node dist-indexer/main.js
npm run test:indexer      # builds, then runs the indexer's pure-function tests with node --test
```

Production build and start of the web tier:

```bash
npm run build
npm start                 # next start -H 127.0.0.1: reachable only from this host, through nginx
```

The site needs Node.js 22 or later (`engines` in `package.json`); Node.js 18 has had no security
releases since 2025-04-30. It runs on Next.js 16, which gets security releases until 2027-10-21.
`frontend/release-support.json` records the end of security support of both lines, and the dependency
gate below fails once one has passed. `ecosystem.config.example.js` lays out the web tier and the indexer under
PM2, the web tier connecting as a read-only role.

### Production host

`deployment/deploy-aiqnet.sh` provisions the host: Node.js 22 from NodeSource, a system user `aiqnet`
(no login shell) that owns the checkout in `/var/www/qnet`, installs and builds as that user and runs
pm2 as that user (`pm2 startup systemd -u aiqnet`), and nginx in front, with `/api/link/` and `/api/cabinet/`
each in a location of its own that writes no access log. Only the `aiqnet.io` block proxies the site;
`www.aiqnet.io` and `explorer.aiqnet.io` have a block that only redirects to it, and `link.aiqnet.io` its own;
every location that proxies sets `X-Real-IP` to the connecting address, and every TLS block keeps `/api/link/`
and `/api/cabinet/` out of the access log (`src/lib/__tests__/deploy-config.test.mjs`). Secrets (`FAUCET_PRIVATE_KEY`, `DATABASE_URL`, `QNET_API_KEY`) go
into `frontend/.env.local`, mode 600, owned by `aiqnet`. The script and `/root/update-aiqnet.sh` each write
`CABINET_READ_KEY` and `FAUCET_PASS_KEY` there (`openssl rand -hex 32`) unless the file already holds one of exactly
64 lowercase hex digits, which they keep (any other value of either is replaced), so the read passes and the faucet
passes the site gives outlive every restart.
`/root/update-aiqnet.sh` refuses to build on a Node.js older than 22 and pulls, installs, builds and restarts as
`aiqnet`.

A host set up before this layout (pm2 as root) moves over in this order: install Node.js 22; create the
user (`useradd --system --create-home --home-dir /home/aiqnet --shell /usr/sbin/nologin aiqnet`); give
it the checkout (`chown -R aiqnet:aiqnet` on the repository directory, which must not sit under
`/root`); `chown aiqnet:aiqnet .env.local && chmod 600 .env.local`; `pm2 delete` the root processes,
`pm2 unstartup` for root, then `sudo -u aiqnet -H pm2 start ecosystem.config.js`, `sudo -u aiqnet -H pm2
save` and `pm2 startup systemd -u aiqnet --hp /home/aiqnet`; point every nginx `proxy_pass` for the site
at `http://127.0.0.1:3000` and add the `/api/link/` location from the script; `nginx -t && systemctl
reload nginx`. Check that `ss -ltnp` shows the site on `127.0.0.1:3000` only.

`scripts/security_hardening.sh` (repository root) adds http-level nginx options only (`server_tokens
off` in `conf.d`). It writes no site: it refuses to run unless `/etc/nginx/sites-available/aiqnet.io` is
the file of `deploy-aiqnet.sh`, with the relay's own location, its Fetch Metadata refusal and zone and the
link host; `deploy-config.test.mjs` keeps every other script of the repository from writing a site of
these hosts.

`npm run lint` runs `bunx biome lint --write && bunx tsc --noEmit`, so it needs bun in addition to
Node.js, and `--write` makes Biome apply its fixes to the working tree.

Never place database credentials, API keys or node hostnames in the repository; all of them are
environment inputs.

## Dependency advisories

Packages that server code imports are `dependencies`; `devDependencies` hold only build and lint tools.
The workspace root (`applications/qnet-explorer/package.json`) declares no packages of its own, so
`npm ci` installs only the frontend's tree. The faucet uses no Solana SDK (see Faucet), so
`@solana/web3.js`, `@solana/spl-token` and their tree (`bigint-buffer`, `jayson`, `rpc-websockets`,
`uuid`, `stream-json`) are not installed at all. `npm audit` reports two advisories, with or without
`--omit=dev`, both reached only through the build and lint tools: `braces` (GHSA-vfj7-8cjw-p6xm, no fixed version
published), through `tailwindcss` and `eslint-config-next`, listed in `frontend/npm-audit-allowlist.json` with that
reason until 2026-11-04; and `postcss-selector-parser` (GHSA-rj75-hqrm-r3gf), the two 6.1.4 copies `tailwindcss` 3
pulls (its own and `postcss-nested`'s), which parse only this repository's selectors while the stylesheet is built:
the fix is in 7.1.6 only, every `tailwindcss` 3 release requires `^6.1.2`, so it is listed until 2026-11-05. The
`source-map-js` advisory (GHSA-68fv-2mgg-jv7q) is fixed: the `postcss` devDependency is `^8.5.29`, which requires
`source-map-js` 1.2.2, and `next`'s own `postcss` resolves to that copy.

The check is `npm audit` in `applications/qnet-explorer` (the workspace root, where the lockfile is),
with and without `--omit=dev`. `npm run audit:check` in `frontend/` runs both and fails on any advisory
that `frontend/npm-audit-allowlist.json` does not list with its reason and an `until` date that has not
passed, so a reason that waits for an upgrade expires. It also fails once the Next.js major that
`package.json` pins, or the Node.js major of `engines`, is past the end of its security support in
`frontend/release-support.json`, or has no entry there, and warns 90 days ahead: `npm audit` alone never
reports a line that is out of support, whose unfixed advisories simply have no fixed version on that line.
`npm run check:release` includes it, and `npm run test:wallet` checks the gate's logic, the dates of the
pinned lines and that the root declares no packages.

Every package the lockfile installs pins its tarball: a `registry.npmjs.org` URL and a sha512 `integrity`,
so `npm ci` refuses any other bytes for it, whatever registry or proxy the host is configured with.
`frontend/scripts/lockfile-check.mjs` fails on an entry without them; the deploy scripts run it before
every `npm ci`, and `npm run test:wallet` runs it on the committed lockfile. A lockfile regenerated by npm
keeps both fields.

## Related documents

- [RPC API](../developers/rpc-api.md) — the node endpoints the indexer and proxy routes consume.
- [State](../architecture/state.md) — transaction types and state commitment behind the indexed rows.
- [Mobile wallet](mobile-wallet.md) — the verifying light client.
- [Maintenance](../operators/maintenance.md) — monitoring and operational practice.
