'use client';

// The one privacy policy for QNet Wallet on every platform and for this website. It describes what the
// software actually does with data — nothing more, nothing less — so a reader can check every sentence
// against the open-source code (src/lib/__tests__/privacy-claims.test.mjs checks several). The QNet app
// links it, so it describes each data flow without pointing the reader to a page that activates a node: the
// addresses of the node pages and the testnet faucet are named only outside the app's view (`full`, as on the
// Terms page; src/lib/__tests__/in-app-pages.test.mjs). The device check of a light node follows
// docs/protocols/light-node-messages.md sections 5 to 9.

import { useActivationContent } from '@/contexts/AppContext';

export default function PrivacyPage() {
  const full = useActivationContent();
  return (
    <div className="page-privacy">
      <section className="explorer-section" data-section="privacy">
        <div className="explorer-header">
          <h2 className="section-title">Privacy Policy</h2>
          <p className="section-subtitle">
            QNet Wallet for iOS and Android, the QNet Wallet browser extension, and aiqnet.io
          </p>
        </div>

        <div className="content-card" style={{ maxWidth: '900px', margin: '0 auto' }}>

          <div className="privacy-section">
            <h3>Who is responsible</h3>
            <p>
              Orrery Group LLC, 30 N Gould St Ste R, Sheridan, WY 82801, United States, publishes QNet Wallet and
              operates this website. Questions about this policy go to <a href="mailto:support@aiqnet.io">support@aiqnet.io</a>.
            </p>
          </div>

          <div className="privacy-section">
            <h3>In short</h3>
            <ul>
              <li>The wallet is non-custodial. Your recovery phrase and private keys are created on your device and never leave it.</li>
              <li>There is no account, no sign-up, no analytics or advertising SDK, and no tracking for advertising or across other apps and websites.</li>
              <li>Transactions you sign are public on the blockchain, as on every public chain.</li>
              <li>If you run a light node, the network needs a way to reach your phone or tablet and to tell that it is one real device: a push token, your node identity, the device&apos;s platform and model name and the device check described below are registered with the network&apos;s nodes and its device-check service, and the node&apos;s answers report how the network&apos;s wake-up messages reached the device (light node answers, below). Those records, the node&apos;s latest epoch not counted and latest answer that the network keeps from those reports, and the aiqnet.io server&apos;s record of each node activation that starts or finishes through the node pages or the browser extension (the activation record, below), are the only data the software keeps anywhere other than your device and the public blockchain; beyond them the aiqnet.io server holds the few request details described below in memory only, for at most a day.</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>What stays on your device</h3>
            <p>
              Encrypted at rest: the recovery phrase, the private keys, the node signing key, in the browser extension the
              node&apos;s activation code, and the wallet&apos;s other private records, among them, in the mobile apps,
              the list of websites connected to the wallet, where each one can be disconnected in Settings. In the
              mobile apps they are protected by the operating system keystore (Android Keystore, iOS Keychain) and by the
              device&apos;s own authentication (biometrics or the device passcode) or, on a device without it, an app
              password; in the browser extension by a key derived from your password; the extension keeps its
              unconfirmed transfers there too. A light node&apos;s device key is created in the device&apos;s secure
              hardware and cannot be taken out of it. Nobody, including Orrery Group LLC, can recover a lost recovery phrase.
            </p>
            <p>
              Not encrypted, in the mobile app&apos;s own storage: the wallet&apos;s public addresses; its settings
              (language, auto-lock, and how balances and tokens are shown); the light node&apos;s link details and cached
              public network data such as the node&apos;s status; the record of the wake-up messages the device received
              in the last six epochs (light node answers, below); the last ten errors the app ran into, kept on the phone
              only; the in-app browser&apos;s list of recent pages (at most 20, each as its address without the query or
              fragment, and its title), which Clear browsing data deletes; and three records of public chain data: the
              QNet transactions it signed that the network has not confirmed yet (so it can resend exactly those and show
              them after a restart), removed once they settle (a summary of each, its recipient and amount, stays 30
              minutes for the same-payment-again warning); the confirmed history it last showed (at most 500 transactions
              for each of the three wallets used last, with their addresses), so a wallet shows its history at once when
              it is opened again; and the SOL and 1DEV sends it made on this device (each with its signature, token,
              amount, recipient, network fee and the SOL a new token account took, its status, the time it was sent and
              the block height until which it can land; the newest 100 for each Solana address), which History lists and
              follows until the network settles them. Not encrypted, in the browser extension&apos;s storage: the chosen language; the list of
              websites approved to see your addresses, each approval carrying a check value made with a key from the
              encrypted wallet data, so that an approval written there from outside the extension is ignored; stored in
              the clear next to the encrypted wallet, the wallet&apos;s public QNet and Solana addresses, a random wallet
              identifier, when the wallet was created and whether its activation is for a light or a super node, which
              anyone who can read the browser profile sees without the password; and two records of public chain data,
              each with a check value made with a key from the encrypted wallet data: how far the searches for the
              wallet&apos;s activation burn have read the Solana history of the wallet (its address and 1DEV account: the
              transactions listed and checked), and the network checkpoints the extension&apos;s light client verified.
              While the browser is open the extension also keeps, in the
              browser&apos;s session memory, which is not written to disk and is cleared when the browser closes: the key
              of the unlocked wallet with its addresses, until it locks; the count of wrong passwords; the result of its
              start-up self-test; and the recent approval requests of each website, for the limits on how often a site
              may ask.
            </p>
            <p>
              Deleting the wallet removes all of this: in the mobile app everything but the language setting, in the
              browser extension everything. Uninstalling the app or the extension removes it too; an iPhone keeps an
              app&apos;s Keychain items after it is uninstalled, and the app deletes them the first time it starts after
              being installed again.
            </p>
          </div>

          <div className="privacy-section">
            <h3>What is sent to the network, and why</h3>
            <ul>
              <li>
                <strong>Transactions.</strong> A transfer, a token call, a move of a node balance or a node registration
                you sign is broadcast to network nodes and recorded on the public blockchain permanently. A SOL or 1DEV
                transfer you confirm in the mobile app or the extension is recorded on the Solana blockchain, which is public
                too, with the memo and reference addresses of a payment request you scanned or pasted for it. A blockchain address is
                pseudonymous; it is not linked to your name by the software.
              </li>
              <li>
                <strong>Public reads.</strong> To show balances and history the app asks network nodes and the aiqnet.io explorer
                about your addresses, automatically while it is open. Like any web server, those services see the requesting IP
                address and the request in ordinary technical logs kept for a short time for operation and abuse prevention. They
                are not used to profile you. The Solana tab loads token logos from GitHub; that request carries no address,
                but GitHub sees your IP address. The app shows no prices and fetches none.
              </li>
              <li>
                <strong>Browser extension.</strong> The extension reads balances, account data and history from the QNet
                nodes and the aiqnet.io explorer, and the SOL and 1DEV balances of your Solana address from a public Solana RPC
                endpoint, all over HTTPS and only while it is in use; those services see your IP address and the addresses
                asked about. For a SOL or 1DEV transfer you start and confirm, the extension reads what the transfer needs
                from that endpoint (the recipient&apos;s balance and token accounts, the mint, the fee and a recent block
                hash), signs it in the browser, sends it and follows its status by its signature; the memo and reference
                addresses of a pasted payment request go into the transfer, and the endpoint sees your IP address, your
                Solana address, the recipient, the amount and the signed transfer. When a node is activated with the
                extension, in Phase 1 it burns 1DEV tokens on the Solana blockchain and records a light node on the QNet
                network, both public, and to recover an activation code it reads the transaction history of your Solana
                address. Before it burns, it asks the aiqnet.io server whether the wallet has a node or an activation and to
                hold the wallet for that one burn, announces the burn with a proof made with the wallet&apos;s own keys, and
                afterwards sends the server the record of that burn with the same proof (the activation record, below); a
                website you approved can read what the extension holds of the wallet&apos;s activation (the burn, its amount
                and its code, all public) without a window. A website receives your public QNet and Solana
                addresses only after you approve that site in the extension, and the approval can be removed in its
                settings. At a site&apos;s request the extension signs a message, sends a QNC transfer, a token transfer
                or a contract call, or moves a light node&apos;s balance into its wallet, each only after you confirm that
                request in its own window.
              </li>
              <li>
                <strong>Light node.</strong> When you link a light node to a phone or tablet, on the app&apos;s own
                confirmation screen, the app registers with the network&apos;s genesis nodes the node identity, the
                wallet&apos;s consent to its own node (a signature of the wallet key), the node&apos;s signing key (public
                part), the device check described below and a Firebase Cloud Messaging push token, which the app takes
                only at that moment. With them it sends the device&apos;s platform and model name (on an iPhone or iPad
                its model; on Android the maker and the model the system reports, never the name you gave the device in its
                settings; never a serial number, IMEI or other identifier), which the nodes keep with the node&apos;s link
                and show in the node&apos;s public status, so that the Device page of aiqnet.io names the linked device; the
                next link replaces it and unlinking deletes it. The nodes store that token, copy it to each
                other, and use it for one purpose — waking the device to answer the network&apos;s status requests for its
                node. Answers are recorded on chain as per-epoch eligibility bitmaps, by node index, and decide the node
                balance. Unlinking the device ends the link and deletes the push token on the device: you ask for it on
                the Device page of aiqnet.io and confirm it in the app on that device, which signs the change.
              </li>
              <li>
                <strong>Light node answers.</strong> With each answer the app also reports, for the earlier epochs whose
                wake-up messages reached the device without an answer, when the network sent the message, when the device
                received it, and whether QNet Wallet could answer it: for example that it had been closed by a swipe since
                it was last opened, had not been opened since the phone restarted, held no key for the node, answered after
                the epoch&apos;s check had closed, or answered and the answer did not get through. The network also notes
                when the answer itself arrived, how long its wake-up message took to reach the device and how long the app
                took to answer. The device keeps its record for the last six epochs (about a day) and deletes it when the
                device is unlinked. The genesis nodes that wake the device use these reports only to tell why an epoch was
                not counted, never to count it, and copy them to no other node: while an epoch runs they hold in memory when
                each wake-up message was sent and taken by the push service, until that epoch&apos;s check closes (about
                four hours); then each keeps, for the node, only its latest epoch not counted (the epoch, the reason, the
                times of its wake-up message and of a late answer, the delay, the network&apos;s refusal code and what the
                app reported) and its latest counted answer (when it arrived, the delay and how long the app took), each
                replaced by the next one. The node&apos;s public status, which anyone can read by the node identity, as the
                Device page of aiqnet.io does, shows the device&apos;s platform and model, the day it was linked, its state,
                the epoch of its last answer and, for an epoch not counted, the epoch, the reason and whether the wake-up
                message reached the device; it shows no exact time, delay or what the app reported. Those are shown only to
                the node&apos;s own keys, in the app on the linked device.
              </li>
              <li>
                <strong>Solana.</strong> The mobile app uses Solana for the SOL and 1DEV of your Solana address, on Solana
                devnet. It reads the balance and the token accounts of that address and, for a transfer you start, what
                the transfer needs: the balance and accounts of the recipient, the token&apos;s mint, the minimum balance
                an account keeps, the network fee of that very transfer and a recent block hash. It builds the SOL or 1DEV
                transfer, signs it on the device with the wallet&apos;s Solana key once you confirm it, sends it, and then
                asks for its status by its signature, with the chain&apos;s block height, until the network settles it. A
                Solana payment request read from a QR code fills in the recipient, the token and the amount; its memo,
                which the review shows, and its reference addresses go into the transfer, and its label and message are
                ignored and never shown. The app uses public Solana RPC endpoints (Solana devnet today), so those
                endpoints see your IP address, your Solana address, the addresses you send to, the amounts and the signed
                transfers, under their own terms. The mobile app sells nothing.
              </li>
              <li>
                <strong>Requests from aiqnet.io to the mobile app.</strong> A page of aiqnet.io can ask the QNet app on your
                phone or tablet for the wallet&apos;s addresses, to confirm that a light node paid from a one-time payment
                address is for the wallet, to link the wallet&apos;s light node to that device (with the wallet&apos;s
                consent to register it), to unlink the wallet&apos;s node from that device, or to move the node balance
                into the wallet: the page shows a
                link (on a phone or tablet) or its QR code (on a computer) that opens the app, which shows the request and
                acts only after you confirm it with the device&apos;s authentication or your app password. The page and the
                app exchange one message through the aiqnet.io server. The request holds a random identifier, a one-time
                public key, what is asked and, for a link or a move, the burn transaction it concerns (or none) and a short
                hash of the wallet address the page already knows (or none), and for the link of a burn made from the
                wallet&apos;s own Solana address also that Solana address, for a confirmation, that hash and the payment
                address, for an unlink, that hash; the app&apos;s answer is encrypted end to end with that key, so the
                server cannot read it. The
                answer carries the wallet&apos;s public addresses and, for a confirmation, the wallet&apos;s signed
                reservation (its public key, signature and time), for a link, the node identity and the wallet&apos;s
                consent (its public key and signature), and for a burn of the wallet&apos;s own Solana address the owner
                bind that Solana key signed for the node, which the page sends with the registration to the aiqnet.io
                server and on to the network&apos;s nodes, for an unlink, the node identity and whether the network took the
                change, for a move, the amount and the transaction; the page keeps what
                it needs of it in the browser, as described under This
                website. The server holds the request and the encrypted answer in memory for at most ten minutes and never
                writes them to disk. These requests are left out of the web server&apos;s access logs, so no log ties the
                computer and the phone of one request together. The IP address of each request is used only to limit how
                many requests one address can make, and is held only in the server&apos;s memory for the length of that
                limit (at most ten minutes). The app contacts aiqnet.io for this only when you open such a link, and the
                push token never reaches aiqnet.io.
              </li>
              <li>
                <strong>In-app browser (mobile).</strong> The mobile app includes a web browser. Pages load directly from
                the websites you open, which see your IP address and handle what their pages collect under their own terms;
                the app sends nothing about your browsing to Orrery Group LLC. Each browsing session starts with empty
                cookies and site data, and Clear browsing data deletes them together with the recent pages. A website
                receives your public QNet and Solana addresses only after you connect it on the app&apos;s own confirmation
                screen, and it receives a message signature, a QNC transfer, a token transfer or a contract call only after
                you confirm that request there with the device&apos;s authentication or your app password. Connected websites
                can be disconnected in Settings.
              </li>
              <li>
                <strong>Push delivery.</strong> Status requests reach your device through Google Firebase Cloud Messaging.
                The app asks Firebase for a push token only when you link a node on the device, and deletes it when you
                unlink the device or when the node moves to another device. The message carries a reference to a recent block of
                the chain, and no node identifier or personal data. Google processes the delivery under its own terms.
              </li>
            </ul>
          </div>

          <div className="privacy-section" id="device-check">
            <h3>Device check for a light node</h3>
            <p>
              When you link a node to a device, QNet Wallet asks the device&apos;s operating system to prove that the
              request comes from the genuine app on a real phone or tablet. The app creates a key in the device&apos;s
              secure hardware; the key never leaves the device. Orrery Group LLC&apos;s network nodes and its device-check
              service receive the key&apos;s public part, the operating system&apos;s proof (on iPhone and iPad from
              Apple&apos;s App Attest and DeviceCheck; on Android from Android key attestation and Google Play Integrity),
              a few yes/no facts about the device type (for example whether it is a computer or a watch), and one
              signature with each node answer. On Android, Google Play Integrity&apos;s answer also reports app activity on
              the device: whether apps are running that could view the screen, show themselves over other apps or control
              the device, and whether other apps are installed, telling apps from Google Play or the device maker apart
              from apps installed any other way. The report names no app, only whether such apps are present. QNet uses it only to
              tell a phone or tablet from other devices, and keeps it only as part of the operating system&apos;s proof,
              for as long as that proof (below). Apple and Google process this on our behalf and keep, for Orrery Group LLC,
              two (Apple) or three (Google) bits for the device, which QNet uses to allow one node per device. The bits
              stay after the app is deleted or the device is reset; Google keeps them up to three years after their last
              use, and Apple until they are reset or Apple deletes them. This is used only to run one node per device and
              to prevent abuse, never for advertising or tracking.
            </p>
            <p>
              <strong>What is kept, and for how long.</strong> The device record (the key&apos;s public part, the node
              identity, dates and state) while the node is linked and 90 days after; the operating system&apos;s proof for
              7 days, or 90 days when a check was refused or a node was paused; a hash
              of each one-time token from Apple or Google for 24 hours, so it cannot be used twice. The IP address of these
              requests is used in memory only, to limit requests and to tell a data-centre address from others, and is
              never stored; only daily counts per network provider are kept, with no address.
            </p>
            <p>
              <strong>Automated checks.</strong> Whether a device can run a node is decided automatically. A
              refusal or a pause never touches your wallet or the balance already assigned to the node, which can still
              be moved into the wallet, and the node can run on another phone or tablet.
            </p>
            <p>
              <strong>Your choices.</strong> Linking a node is optional; on a device that cannot run one the wallet works
              as before. Unlinking the device ends the device check for that node. You can ask us to delete the device
              record and the stored proofs earlier; we keep them only while an abuse case is open. Legal
              basis: your consent on the link screen for the device check (withdrawn by unlinking the device); our
              legitimate interest in preventing abuse for the IP-based signals, to which you can object.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Device permissions</h3>
            <p>
              Biometrics or the device passcode: unlocking the wallet, through the operating system, which never shows the
              app your face, fingerprint or passcode. Push messages: the status requests a light node answers arrive as
              silent data messages, only while a node is linked on the device, and the app shows no notifications for
              them. Background execution: answering them while the app is not open. Camera: only after you tap the scan
              icon on a Send screen and allow it, to read a QNet address, a Solana address or a Solana payment request
              from a QR code; what it reads only fills in that Send form. Frames are decoded on the device, on Android and
              iOS alike, and never stored or sent. The app itself uses no photos, location, contacts,
              microphone or files. On
              iOS below 18.4 a website&apos;s upload sheet in the
              in-app browser can still pass that website a photo or file you pick or take there; the camera opens only
              if you choose it in that sheet.
            </p>
          </div>

          <div className="privacy-section">
            <h3>This website</h3>
            <p>
              aiqnet.io shows public blockchain data. It sets no tracking cookies and runs no analytics or advertising scripts.
              The web server keeps ordinary access logs (IP address, requested page, time) for a short time, except for the
              requests between aiqnet.io&apos;s pages and the mobile app described above and the node pages&apos;
              requests about a node, a wallet or a payment address, which it does not log. Pages load images only from aiqnet.io: a token&apos;s logo,
              which its creator records on chain as a link to any web server, is fetched by the aiqnet.io server and
              served from aiqnet.io, so that server never learns who views the token. To limit how often one client can
              call the site, the server counts requests per IP address in memory, for the length of each limit (at most
              an hour), and writes those counts nowhere. When you press Connect wallet and approve the site in the QNet
              browser extension, the page receives your public QNet and Solana addresses; My node then shows that wallet,
              and what it sends the server is described next. What the extension answers on the node pages about the
              wallet&apos;s activation is shown there, and an activation it reports is kept in the browser, as below. The node pages{full && ' (aiqnet.io/node)'} send the server the light node id of the wallet you choose there,
              or of the extension&apos;s once you approved the site in it, to read that node&apos;s public status and
              history from the network and, when you press I&apos;m back, to ask the network to wake the node&apos;s
              linked device, and what an activation on those pages needs, described below. They also send the
              wallet&apos;s QNet address, to ask the network whether the wallet has a node of either type and to read the
              wallet&apos;s activation record, the id of its super node, to read that node&apos;s status, and, when the page
              knows it, the wallet&apos;s own Solana address, whose public Solana history the server searches for an
              activation burn: the server asks a Solana RPC endpoint and keeps the answer in its memory for five minutes.
              For a day after it last read one, the server also keeps in its memory the ids of the nodes the network lists
              as registered, with nothing of who read them, so that the reads of registered nodes keep a share of the
              network&apos;s answers of their own. The site stores in your
              browser whether the QNet or the Solana address is shown and, for the node pages, the wallet address you
              chose there, or the extension&apos;s once you approved the site in it (with its Solana address when the
              extension or QNet Wallet shared it) until you change it, after you press Disconnect there a mark that keeps
              the page from connecting the extension&apos;s wallet by itself until you connect a wallet again, a request
              from those pages to QNet Wallet
              with its one-time key until the page has read the answer, so that it can still read it after the browser
              unloaded the tab, and the record of an activation on those pages: its payment address and key and what the
              activation has reached so far (QNet Wallet&apos;s confirmation that the activation is for the wallet, with its
              QNet address, public key, signature and time; the burn and the transfer back, each with the pass the server
              gave for reading its state; the request to QNet Wallet; and the wallet&apos;s answer, with its public key and
              consent), and the activation the QNet extension reported on
              those pages for a wallet (the wallet&apos;s QNet and Solana addresses, the node type, the burn, its amount and
              the activation code, all public on Solana or on the QNet chain), for at most five wallets, so that the node
              pages can show it again. When you follow the node pages&apos; link to the testnet faucet, the page keeps the
              connected wallet&apos;s Solana address in this tab&apos;s session storage until the faucet page reads it
              once to fill in its field, and removes it then; nothing is sent until you press the faucet&apos;s button. With
              it the page keeps the faucet pass the server gave for the wallet of the activation, the same way, until the
              faucet page reads it once and sends it with your claim.
              The browser keeps those keys for this site only
              and never hands them out. A request expires after ten minutes; the page deletes what is left of an expired
              one when it next opens. The Support page&apos;s device-check form sends nothing to the server: it opens your
              email app with the message it wrote.
            </p>
            <p>
              <strong>Node activation.</strong> An activation on the node pages makes a one-time payment address in
              your browser, for the wallet QNet Wallet confirms first. Its key never leaves the browser, and it signs only
              that activation&apos;s burn, the owner bind naming that wallet and the burn (right after the burn is signed,
              before it is sent), and the transfer of whatever is left back to the wallet. When the node is registered,
              the page sends what is left back to the wallet and deletes the key. If nothing was burned within 24 hours
              after the activation started, it sends back what arrived and deletes the key then; after a burn it keeps the
              key only to send back what is left, until the node is registered or you ask for it at once, since the
              registration needs no key and can be finished in any browser where the wallet is connected. What is left
              goes to the wallet&apos;s Solana address when the extension or QNet Wallet on your device shared it, else to
              the Solana address you enter. On testnet, when the page does not
              know the wallet&apos;s Solana address, it does not ask for one: it leaves the test tokens, which have no
              value, on the payment address and deletes the key. You may instead leave it on the
              payment address: the page then tells you that nobody can move it once the key is gone, and deletes the key
              only after you confirm. On mainnet a payment address with nothing on it keeps its key until you delete it,
              in case a transfer to it is still on its way. Once the node is registered and the key deleted, only a receipt
              of the activation stays in the browser (the payment address, the burn, its amount, the node and the
              wallet&apos;s QNet address), at most ten, for the node details on My node; its activation code names the wallet,
              not the payment address. The page sends the aiqnet.io server the
              payment address, the wallet&apos;s confirmation, its signed transactions with the owner bind, and the
              registration (the wallet&apos;s public key and its consent), and My node sends the wallet address you chose to
              read its registration; the server passes
              them to Solana and to the network&apos;s nodes, and every one of them is public on Solana or on the QNet chain.
              The server keeps no list of the transactions it passed on: so that a page can read the state of its own, the
              server gives the page a pass for each burn, and for each transfer back from a payment address one of its
              reservations named, computed from the transaction&apos;s public signature.
              A registration links the payment address that made the burn to the wallet&apos;s QNet address on chain.
              The payment address gets its tokens from your own wallet.
            </p>
            <p>
              <strong>Activation record.</strong> One wallet gets one activation, for a light or a super node. So that
              every browser and device, the extension and QNet Wallet see the same, the aiqnet.io server keeps, for each
              wallet whose activation starts or finishes through the node pages or the browser extension: the wallet&apos;s
              QNet address, the node type, how it was paid (the extension or a one-time payment address), the Solana
              address that burned, the burn transaction, its amount and the times it was reserved, sent, burned and
              recorded, and the proof that the reservation and the burn are that wallet&apos;s: the wallet&apos;s public key
              with its signed reservation (its time included) and, for a burn of the extension, its signatures over the
              burn, or, for a payment address&apos;s burn, the payment address&apos;s owner bind. The burn, its amount and
              the Solana address that burned are public on Solana, and which wallet a burn is for becomes public on the QNet chain
              when its node registers; the record shows that link from the start and never shows the proof. Anyone can
              read a wallet&apos;s record by its address, as the node
              pages, the extension and QNet Wallet do. A record is kept while the node pages run, since a burn is public
              and permanent, whether the extension or a payment address made it; a reservation without a burn goes within
              an hour after its ten minutes end. No IP address is stored with it.
            </p>
            <p>
              <strong>Testnet faucet.</strong> The faucet{full && ' on aiqnet.io/testnet'} sends test tokens (1DEV and SOL on Solana
              devnet) to the Solana address you enter. The aiqnet.io server sends them from the publisher&apos;s faucet
              wallet, so that transfer publicly links the faucet wallet to your address on Solana. To allow one claim of
              each token per address a day, the server keeps the address and the time of its last claim in memory for 24
              hours, and then drops it; it is never written to disk. Most of each hour&apos;s claims are kept for people
              activating a node, each part until its share of the hour has passed: the node pages send the server the wallet&apos;s confirmation that QNet Wallet gave for
              the activation (its QNet address, public key, signature and time) with the payment address, and get a
              faucet pass for that wallet, which names the wallet and the time it ends, an hour later; the server keeps
              no list of the passes. A claim with a pass allows one claim of each token per wallet a day: the server then
              also keeps the wallet&apos;s QNet address and the time of its last claim in memory for 24 hours, in the same
              way.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Retention</h3>
            <ul>
              <li>Data on your device: until you delete the wallet (the mobile app then keeps only its language setting) or uninstall the app or the extension.</li>
              <li>Push token on network nodes: until the device is unlinked, until the node is linked to another device, or until the token no longer accepts deliveries — for example after the app is uninstalled. The node registration is part of the chain and stays.</li>
              <li>Device check: the device record while the node is linked and 90 days after; the operating system&apos;s proof (on Android with Google Play Integrity&apos;s report of app activity: apps running that could view the screen or control the device, and whether apps from Google Play, from the device maker or from elsewhere are installed) 7 days, or 90 days after a refusal or a pause; token hashes 24 hours; Apple&apos;s and Google&apos;s device bits as stated above.</li>
              <li>Requests from aiqnet.io to the mobile app and their encrypted answers: in server memory, at most ten minutes.</li>
              <li>Activation records: on the aiqnet.io server while the node pages run; a reservation without a burn at most an hour after its ten minutes end.</li>
              <li>The server&apos;s search of a wallet&apos;s Solana history for an activation burn: in server memory, five minutes.</li>
              <li>The ids of registered nodes the node pages read: in server memory, a day after the last read.</li>
              <li>Testnet faucet claims (the Solana address and the time of its last claim, and with a faucet pass the wallet&apos;s QNet address and that time): in server memory, 24 hours.</li>
              <li>A light node&apos;s answer reports: on the device, the last six epochs (about a day), deleted when the device is unlinked; on the genesis nodes that wake the device, in memory until the epoch&apos;s check closes (about four hours), then only the latest epoch not counted and the latest counted answer, each replaced by the next one.</li>
              <li>IP addresses counted for request limits: in server memory, for the length of each limit (at most an hour).</li>
              <li>Blockchain records: permanent by design and outside anyone&apos;s control, including ours.</li>
              <li>Server access logs: a short, fixed period.</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>Sharing and selling</h3>
            <p>
              No data is sold, rented or shared for advertising. The only third parties that process data are the ones named
              above — push delivery (Google Firebase Cloud Messaging), Apple and Google for the device check of a light
              node, public Solana RPC endpoints, GitHub for the token logos of the mobile app&apos;s Solana tab, and the
              app stores that distribute the software —
              each for the single purpose described. Websites you open in the mobile app&apos;s browser see your IP address
              as any website does, and receive wallet data from the app or the extension only as described above, after
              your approval; what they do with it is governed by their own policies.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Your rights</h3>
            <p>
              Under the GDPR, the CCPA and similar laws you can ask what is held about you, ask for it to be corrected or
              deleted, and object to processing. For everything on your device you already have full control. For the push
              token, the node registration and the device-check records held by network nodes and the device-check
              service, write to <a href="mailto:support@aiqnet.io">support@aiqnet.io</a> with your node identifier.
              Unlinking the device ends the link and the device check; the device record and the stored proofs can be deleted
              earlier on request, except while an abuse case is open. A registration is part of the chain and
              stays. An activation record repeats public chain data and keeps the one-activation rule of its wallet, so it
              stays while the node pages run. Records on a public blockchain cannot be altered or deleted by anyone.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Children</h3>
            <p>The software is not directed at anyone under 18, and no data is knowingly collected from children.</p>
          </div>

          <div className="privacy-section">
            <h3>Security</h3>
            <p>
              Keys are stored encrypted — in operating-system-backed secure storage on phones and tablets, under your
              password in the browser extension — and never leave the device. QNet transactions are authorised by
              ML-DSA-65 signatures made on the device, and SOL and 1DEV transfers by signatures of the wallet&apos;s
              Solana key, also made on the device; a connection to a node or to a Solana RPC endpoint carries only public
              chain data and already-signed transactions, so the signature, not the connection, is what protects funds.
              Connections to aiqnet.io, to the QNet nodes and to the Solana RPC endpoints use HTTPS.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Changes</h3>
            <p>
              This policy changes when the software changes what it does with data. The date below is the date of the current
              version; the history is in the public repository.
            </p>
          </div>

          <div className="privacy-section" style={{
            textAlign: 'center',
            marginTop: '3rem',
            paddingTop: '2rem',
            borderTop: '1px solid rgba(0, 255, 136, 0.2)'
          }}>
            <p style={{ fontSize: '0.9rem', opacity: 0.7 }}>
              Effective: October 6, 2026
            </p>
          </div>

        </div>
      </section>
    </div>
  );
}
