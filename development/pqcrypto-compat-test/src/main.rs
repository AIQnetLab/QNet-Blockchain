/**
 * pqcrypto-mldsa 0.1 (ML-DSA-65 / FIPS 204) self-test + cross-verify against Android pqclean C code
 *
 * ARCHITECTURE:
 *   Android (pqclean C via NDK)  <->  Server (pqcrypto-mldsa 0.1 Rust crate)
 *   Both use PQClean ml-dsa-65 reference implementation -> byte-perfect compatibility
 *
 * EXPECTED SIZES (FIPS 204 / PQClean dilithium3, CTILDEBYTES=48):
 *   PK  = 1952 bytes
 *   SK  = 4032 bytes
 *   SIG = 3309 bytes
 *
 * HISTORY:
 *   Bouncy Castle 1.75 -> SIG = 3293 bytes (CTILDEBYTES=32) -> INCOMPATIBLE with pqcrypto-dilithium 0.5
 *   Migration to pqclean C (NDK) -> SIG = 3309 bytes -> COMPATIBLE
 *
 * CHUNKS captured from emulator logcat (tag DILITHIUM_JNI), build 2026-02-20
 *   Seed: "QNET_COMPAT_TEST_SEED_v1", msg: "compatibility_test_message"
 *   PK_LEN=1952, SIG_LEN=3309, SELF_VERIFY=true on Android emulator x86_64
 */

use pqcrypto_mldsa::mldsa65 as dilithium3;
use pqcrypto_traits::sign::{PublicKey as _, DetachedSignature as _, SecretKey as _};
const PQCLEAN_PK_HEX: Option<&str> = Some("025e5a4232cf32061888737ce371e70569224865a4869cf92dcd83271e29bd8b2d9c80a9d3cf669139d4efc6e94f9016d2a7b5a00eee12be1537ac8b3e03e4028fa69c01f79afd0141abf9fbe431d0f62d3d077bf5a04b83711560dc2b16dfb1862ded1ea935894af0e3d2f72751df38b2416d656d6259b8223000a850cfbb82035e7da1e8ec84e7d3a1c598c56dcd85054a619d5202faee9e9d6eeab9788781ef1242421dcef9e95b6a22ac7e1d0a26a954d4f342f9563369f2d228d516ec25b45ca53bdc67aeb0f61685d7e587ee6487960ff2dd2799ec47f6936f90e70da3399086d7fe592e8fc8421688bcd4527d32b86c6ff1672dfaec3ddd076b872900fe6c73a32520ec8c50444bd7fb64460e1b8a3bf421326a3dee0c934cb5f1dce5dceae7e200d26c8b0eba5a4668a7b18e0ef83b6bf4d89b1cd43322a6f1aaddf850871390fd5807a8fb1fa857a77551fdffb0b4585f8c02fe18f7d8abd80d8a1a4ca6dddaa7ce95f8f6ed05024b75a705a977b6cb65d2d2a1f27601ade2411d358a8b20a732b06b8f45175b1526e13af167d892ff3d1a64bce277a77f1be6778db983d730dd120d5a694e7f18bb3f1ab2b805c0033fba643a13384299089dc7f9cb6c7cc7f9472eb6ab40ff491614a58a4e6e0a837e3a0622ae2073a992ef12dae9cf6d147e11437b41d20426f63b0a849401cb65e8cab2908bc803c089c2812b868f060a4d1eba934fba3f712b6bbf90c36153374ea5a4bdb52b01c0eb0a2007a52ae1043d5e573cf7bd885a3feae8bdd2db3014de297d8b2f93e34e6387e87a31020e0dbc9d8570f5bb3855e45e4b30f137a418f9162c26fb7909036317cfba6e0feaa2ece368f564e09776e124516946252b0dc87cc97399f505520d714a3a441666e93a851c0a11742c5934cef18a9b941993c62643f73d2bb133715fec30bf121cb36f3e953887564fe6b751303d2e328d0013e7366d0c933e8d1f60d4e4e49a9d30e2d48fe02841c834f09b5325ff7dc8a0c720375d4c704b7fed85f47a344800b22b4e849953e3e65e94b1eb9fb6e6dfa9794a62693d9d383a5bb2b10474a977cd979f3bfb5b8a2580838a96778d5e249706f934b90634f2d06fd79bb142b63f0d9842540f101858f93b88afff70924917f164e16337ead4130dd5362046292e967489589fc159210cb40a2f33f954d56035ae45aa8ce3412ba40cc2f361dffedfda01e5aa292ac91bbb9393202d201b20cc535c3792fb7320de8c250d5d3befc9e2d7aa94f8f24e8c727be9c5b390e09c9099a9b9bf0dc9c485ce797635275187eb555e00beeffcceb1c0d0c4f5227f5297b468ba6e15254416c3c96ad50565de6e760ec98a062eba13b346318ad174f2e123bc11f1149baafc74f3ee83d3ffefa054b8732aa36aff963bc3dc597cf9444981d62aa15c7a8116dbb951a457ea78b1a7465676d7d88d5db9c1bc273f76b8e12cd8b87eb5937468066dcd06ef5be05ac4c7d7b9a405871bf1d5178716cbd3c1e1ac703a2a7ac3c629149311e42372515699c2d2fd4395cf59f7de26103e613ce729175423042ebabfb2fb673b214131bea6aaae4b07bbdcd85d73c08446654c92020edb9dc34bfc239538b8741de35d2216d17fecad359b9e82f14c36ddeb5d9fcd37721f2a8488b1ed1615921b0c0c9f85d37e98e0e950c71228cb0ec9fa90c94fa1bd59dab30e564bf3be3a5616367536f6fad7761c7f8e7f479f78dd130dc7336c2cd3efd7949f5d5defabb955771009bdf91d1dc397227b2865690a74fabb091ea77d7b8655683e5d464e94b02d7e3e74254ed1fc7a6ca206f5ab6b4d588c2019344c68e30285c93ad15068601b3745b75a63be5a50a8f5600ad51eb910c95c40add159a207ccb44a0db827b974138317da0c33af04f7bc9929168c4ab2b514c920f288693529f4d0cb881cd1ee5685477581531b366b17d8272d629dc2a656b5a553be7ad3953e4764503fa3206ba5c66c88e330fc528f1f830c2018b3d551898424644d00c865c0db55ff99c2c78c6ce83d3dfa2221c1c18a589d4c2ffc937d94050ef8a5e0d0df3ed2c1d7668aa7199823b0503defa30341f288d224f47fa30e1b8cbae2b144ddec79421a6a4dafd2e70eb922a460e0a89e550dea38df27c68e1fdb76df98bd26d0f98fcbdc613e8f1b3ccb9686effe38ee893775449ac3de1fdfed9e15454e028eb9ff64ba7411ead5cff056966d66eb08f7f8353ec7e55133be8def3ba050e9f021f0de491fc5590f89fcd02355628371ed42851e0c3ed38fc9aa09d5861ec3e88f9c1148f45bffd0258ab859b1091bed5746ad1ad1ff235e853dbc2badcaab789930e289c2c5af0147bcef5be12da9942df0ab76e35e196e005e5c9cdb18a6e8e52a087086c2bbcc8bf802888058fc84e68b0ae148219a23468f95eb90efb489ad27a846aea8e5206f98d4dc7124b022faa4f10840ca1b95004b22b6ea1c4d73f742a9acf33a21e723ad61a545bc6ac58f4a6092820a697c616ab661d875fe07f09bb6eb6af6eb7c5e9027c899d824781b6361ec6dd640a64de82f78516604b5d0b2af2118c04ca36e814d74afb4ba1d961cbf1283ecd552ccf48d6f501624ad083b5bb0b6c4b600dd421bf5ec3f327ca5448a91dbe1914636915757c505575a2f70d852bfb885ee67f36a926c15e7447c08b49cfdf6d8a649a3eb4ae60d5d7acfb2898032f4d5dbdb2f11525c3ac41cad1c44f54cce40c4182ad49267c8ec");
const PQCLEAN_SIG_HEX: Option<&str> = Some("40907767f423e84426b27af281cdf84d9d58e8b88fd9e84ac29280c6806f770ec065490ad6b5d6479b48adcf8a29f4b0162b8e68e471f7b016dbc90df150e1384f60639d8e0276610bd0fc8cadcbc759e51260d0e905f1179ebc357c38da79393c14bf5d4f70a84e0c7e6ef568dccfe2b5c380ee067e641e0fd9d8da397f1128cd13894a11a43c1a0adcca452021f15f3cad04d7f3b53c1d41ee5781896ca7f75e7bf72af3284c4403b8d72c37d2a3e3883a7ed944ca3b2a97f7bbcc61c1381ec22ac0c05f6db30d84eb8c289e6e5095ed1fa709e2ab016bf3beea51291745269540fba2e291bb74621b715e590c4f90378dc85a9f72a3e37a9b3de1a135eb3b5fc4687baedd9696854a469b67e75ad3e36cade42d1b87f574ce23727e5011bb88bc84b890758e78db6b7acc936155b592628e739e87a142d952668a2d8062a171d2411caf54f9bc5f664e391457252b27d939c8d0e4d6b7630fd0c969aad47a69034c4e386dcc3fbbc7f76e4cf0eb3ba9bc75b934bbc0b770660e9979a5b354fc1eebbe893df75da5d9e65c592b7f8811c6e6f164d4e03563041b32d6cad63c981b5e20b40f6fe489ba6ae7b39e87ebedf55a834063bc4d32bf3787a991f32c3a9aef0c4b3ce8650175a4cc02733a9319875d2a3e05ee320134abb31e995fa1e3b40e6042e2a2efc1a5350d78e36a75e03cac3751eefa8095468d3e63d19012e23d6b2f2b84a22a30c160921c365c3f048535c9a9ca65fd6c17caba31312fab009f72ef9f2cb7ee2ef16e85ea93fa7d9fa87cfa1ea395eed4a8fedcf84e06b94601065193247945419bf250763247b3923a245d23d0516502ea03cfbcd4054bbaa57777513c3424a2df39bf2aba102c0d29fe977d1f1fce6540b1a5d99aa4e890f95a866a3fd42f63c33243e778f4c2b594ea6d62ab9a0842fb402767a46f58cc37e67b5dd93be7b58388878972c34314737ad61f2d64e0d9fc3cab5fe823666add8409f8731e09c54d2e62cbb510f55e14cfbb59330c1349d2f179abfcd91a6ba9d11f2a9a35411ffe54381175bf72aca903634ac26f619fb2487803b0f2c353c6dfbbfbe9528523119be7f93c726e6a44f326e804aa16c69583feba0b3d11f0f07275508eee63be23f624c97f09b67f12640eb11b4115f20dea66799c17f22980c05b1c70a407e5ddfe62399607bacc75d755e45ec43da86a0c4a3a5ac96e301e9344c2c1eb87b25620ebda879ada845697a25c97925dc514a939e9f31c08b4ca2fa6acd2f056063521e6c7919cae0d182d5d4257540f5116544ffaeb79fa30639b9703272022462715843edc57d562fbea7f08f16838c6cf356431af110e3214c91e863282b8ac7550b7fe5a7e7b52a8499642cd14c1cf2031670eff3b7aa3e410874c8c243c829de67139113ca5e3e5a867b548cd1abf01240293cf9e91037cbc4d860f32d4907bbf203fd8c16017be8aaed6d1278ddebf241fbcbd6edbaaa01189ea810b9327e77d88c2dcbb03cbb1832506d93f451b2891d6edee3be45f4cda41912b50e71587059a59c4597873e582c33742ad41a04d09330772ab2858bdd3ade7bd8eff6d5882456907d2a44dcd23a8816079ccf88ff280aad379d3ff1b1512a4241c1b59eb45559bf227547f7c518fa42f6126b1f8689dfd137a7c194f2bb66379269e897d26494f859f0255a256869a6c337d63ab239b0b022c75442212267cb5fe136bd8822d30f2e436d82794a0a5726b888c24de729c7385d092fda872896ee05b8117cdb5909a859bd2ef8d0b1843c0e0f6cee493be7a81044fb553d33251d39bc6a372ec123569d7566c158760e9003cd943fe6222b723151780a98959473043b08de05dcb7db20c129df36008a85867d8494402cb6a0997df60b50eea895ccdb4f8c56d788d3fc7040805aa5162682f4e651cda47f79ae5215b951c0f7c9d89a96c589cfaf38aac032b8093383d485d426a6f3e5563a0296bcf6df28408b69780f9cb076bf45dbc68687f23b5dbb0d205519da589a28b093c82b5d66e40a2aee1c06c86bf679897c80692017c8de3f3e06f0b50a28fcfad7ab84aa798263d8bc289c6e7a31d6b44192f88e6184a5af6bb190b0360550479bca82e9ffdaa0754072b20936ecc580b6604ee2755814c62af9f9f6373c71c0e7cda40185c4742b80dc041422d42ce304dde4397d8840d8468f4d20e524c567953b49c31f33e1786e899a506bc1242318e865f9260f1623ae40749ba9da6ce92da77ae4e287b1f4d0f8028a3aef791d43f976cdeedd34297db25b9ab390e8edfd499d18e2e3272a7e8e8c85e871ba27c787a5501deb55d5c083de3979333f66c0e5d64c421642110a5990319c814b68591ba5f59d2514dae24e1862ce3879073274d995fb413e11ff44d9b7fcb91f3e81edcb2bd6740c7160a8e935fd6c86305ec07c64103e598dd550678f6b348d2627bc837064fd7cddff1786312d9dd756f2eb95f429180ccd01a56f88ef027d3f74f150d1aed6a62791a31b743fa934a700b23c196638c3e38424929e353aed0d4fb1ab462a02f63ce2ce8a9a3b2179a813575ccfba6e85bb8ca89533e63f7133263e5c3f3bc016c33d08618bcc82c7129db422e1caecf80283b70ee861288261738775be66653b39ae1100b15aee5de8b78145b4680175a92e9a3f6dea1a2251a9b2da15719d8d0f8e034a6d0fd8611a4a740848dcc2676060001abe7fec8ab9dfc2d3ed69d55d8f05aedc2ea1c6b88c2b42b7b39c0f7f7905b1c95fb0fe7c6436c16492c503d38b2b14347fe67f54e8399f9c58c941c257827683342b485ba5bef39dff70123933654ac2408e57b184af728084b7124b50699494a7758869bb0ba4d053e8e189d2e4148a21f614f447ac1a18b02fa81e76f837e3d883b50dacb5365452214c07d1d0e11feef481998959fc0314dd84f7193c9819831f356ea041be8c6d836899b586424bd17568479578b2eb5c9e8d28c4a9046a9d99af870d8ffe6e4cccf5cf06f64ee5f3c212eabfa513f4538853aed5ac408a2bae032cf5069e97b165027429d8750ea559511cdeb61d9ce3b2d51741feecb150b6aeb24cbbf8bfa26a5998a19b0a588615c2740f141b062ef71d52ea5ed4bbcce55418df69c3c5d372d450e96074a37b34932f9e69c054644f3dadb7aa28ab9703564485e4dc2751d6dadf00a445faa6bb24356c7d44bd930190cbe71f15c5df8d27797bff7d922a723636993419911a693fcd27e4b6928bf6498d3b00847aca8d2cd011ace89ed81091432db2cec351ad10215c9e6c5c2d9686bfab728022ca565e750f7a6a65505cdba41b2ee2754826623f3f275b217487bbc85c0ebedb9f18f0b90b543d74843a16e85ced21a1d1ac99fcf88e68ec66c931ce52f60371b3dcd40c927e932888319fe5016734a1d923afe74795f664a82e1fe2986d3c1714ccc3943e6d013f33fdcb0e24060b713f3c8a53afdfc58904a48df335e2563e34d4506cf58a0694a01457b6522e0bfbc7065c6a16243584663f78c2b2ae78f3a7274184863e638a85944dce61e336149da9b5a628015339035d69f17b5b91b1b6f116154497e6fb26f86f7f3e088b46c83e5fe84b7e0393729eb04d3f9dee737f435d1a89cac6ae1433f0d3ec873dd0e668951eb7bf3ffedc8a92a1b81fb752df56c30e3b260083c6c904cba669429de56d3248ff35be17be3f0ee99ee9ffbf239570a6eb25e26f368d6eef41aa51da3a0fbfd510a44b51a98144881bf9df9278db3a8b3d514228bc84ce1dd05f92eae6d0a5f88a188191429d82ded29eea0df6b34aa6b1da4a9c0a959a5e22b46ca65d2f32f0a3a64683863200285de981d2e26f6d72a63a12c769f787a7eddadf13092cafb1896af95c34e401c92434a5a93a45c8eade3ff042f4c6dab84f9a39bd3b5cdca0b0953c86dca2abca0e6ccc8a4f9649e55ab6ecad67b99d26b508cb724117242ea891be8f290f337c2a975fcc67e5d1d022dd6ae562ea3025c82c1e4dfbbe33c6ab8bc08515d7ce4c43e89496d86b44fd5f77a28219154e4f56b32a88c05f811ecff92af33f6c7fefb670475294644e8a977253b640c7412543688dc5297a609520be99c71bc37835b0a8cfcaa74f026327f59af7a521da74e8bfe822cbc95447c167568dd163c1d33276ad54867e3675d339881ecfbb9875e77d8410b998ff10945f2d82de30f007277128548f96b6c50bbdbe3d771ffd3e8a941704a3061b5ea23e891bb21f23a38e337fc5be1bb766679dd0fae13997fb414d313271be691d872eb8e41e2502e8c038a74d0d6fa39ad4b59e11df6e5966d8a1348a307c8bd405a9598015d5c73f7f1797bba72d69d262e982afb6e1be7f6c19d88f1de5c91df17b4add9cae95222b52e090eb7b05ca3d2afa0f5e5cf28ad2a7d38e80f0f0ac51f1a44b67903407117219081b84456ce2dd734408e1d368e3c2dd745a69e61689dbb1f5cdbe53a86530650e5812bc3603c6fc79cd52f8a9ce93a453a9024cf45d506f27476bb9061e16e9f75e5d54bfbde11500e3331e77de12f333a147434a58cab902f023e8f831f060b03f9b01fd65c0a363843bfc1cccfd9366d7e8791103d607cb50d1e287d96e1224979fafcfd030982000000000000000000000000000000000000000000090e13191f22");
const PQCLEAN_MSG: &[u8] = b"compatibility_test_message";

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    hex::decode(hex).expect("Invalid hex string")
}

fn cross_verify_android_pqclean() {
    println!("\n--- Cross-verify: Android pqclean C -> Rust pqcrypto-mldsa 0.1 ---");
    println!("Seed: \"QNET_COMPAT_TEST_SEED_v1\", msg: \"compatibility_test_message\"");

    let (pk_hex, sig_hex) = match (PQCLEAN_PK_HEX, PQCLEAN_SIG_HEX) {
        (Some(pk), Some(sig)) => (pk, sig),
        _ => {
            println!("SKIP - chunks not yet collected from Android device.");
            println!("       Run the new pqclean NDK build, then:");
            println!("       logcat | grep DILITHIUM_JNI -> paste PQCLEAN_PK[N] + PQCLEAN_SIG[N] above");
            return;
        }
    };

    let pk_bytes = hex_to_bytes(pk_hex);
    let sig_bytes = hex_to_bytes(sig_hex);

    print!("PK  size: {} bytes (expected 1952) ", pk_bytes.len());
    println!("{}", if pk_bytes.len() == 1952 { "OK" } else { "FAIL" });
    print!("SIG size: {} bytes (expected 3309) ", sig_bytes.len());
    if sig_bytes.len() == 3293 {
        println!("FAIL - 3293 bytes is old Bouncy Castle (CTILDEBYTES=32), not pqclean (CTILDEBYTES=48)");
        eprintln!("ERROR: Replace chunks with data from the new pqclean NDK build.");
        std::process::exit(1);
    }
    println!("{}", if sig_bytes.len() == 3309 { "OK" } else { "FAIL" });

    if pk_bytes.len() != 1952 || sig_bytes.len() != 3309 {
        eprintln!("ERROR: Size mismatch - chunks are not from pqclean dilithium3.");
        std::process::exit(1);
    }

    let pk = dilithium3::PublicKey::from_bytes(&pk_bytes)
        .expect("Failed to parse PublicKey from Android chunks");
    let sig = dilithium3::DetachedSignature::from_bytes(&sig_bytes)
        .expect("Failed to parse DetachedSignature from Android chunks");

    print!("Cross-verify Android pqclean C -> Rust pqcrypto-mldsa 0.1: ");
    match dilithium3::verify_detached_signature(&sig, PQCLEAN_MSG, &pk) {
        Ok(()) => println!("PASS - byte-perfect compatible"),
        Err(e) => {
            eprintln!("FAIL: {:?}", e);
            eprintln!("Possible causes:");
            eprintln!("  - Chunks are from old BC build (SIG=3293)");
            eprintln!("  - pqclean version mismatch between Android NDK and this crate");
            std::process::exit(1);
        }
    }
}

fn main() {
    println!("=== pqcrypto-mldsa 0.1 (ML-DSA-65 / FIPS 204) self-test + cross-verify ===\n");

    // ---- Test 1: Key sizes ----
    let (pk, sk) = dilithium3::keypair();
    println!("PK size : {} bytes (expected 1952)", pk.as_bytes().len());
    println!("SK size : {} bytes (expected 4032)", sk.as_bytes().len());

    assert_eq!(pk.as_bytes().len(), 1952, "PK size mismatch");
    assert_eq!(sk.as_bytes().len(), 4032, "SK size mismatch");
    println!("OK - key sizes match FIPS 204 / PQClean dilithium3\n");

    // ---- Test 2: Sign + verify ----
    let msg = b"compatibility_test_message";
    let sig = dilithium3::detached_sign(msg, &sk);

    println!("SIG size: {} bytes (expected 3309)", sig.as_bytes().len());
    assert_eq!(
        sig.as_bytes().len(), 3309,
        "SIG size mismatch - wrong Dilithium variant (BC=3293, pqclean=3309)"
    );
    println!("OK - signature size 3309 bytes (FIPS 204, CTILDEBYTES=48)\n");

    print!("Test 2 - detached_sign + verify_detached_signature: ");
    match dilithium3::verify_detached_signature(&sig, msg, &pk) {
        Ok(()) => println!("PASS"),
        Err(e) => { eprintln!("FAIL: {:?}", e); std::process::exit(1); }
    }

    // ---- Test 3: Modified message must fail ----
    print!("Test 3 - verify rejects tampered message:           ");
    let wrong_msg = b"tampered_message";
    match dilithium3::verify_detached_signature(&sig, wrong_msg, &pk) {
        Ok(()) => { eprintln!("FAIL - accepted tampered message (critical bug)"); std::process::exit(1); }
        Err(_) => println!("PASS"),
    }

    // ---- Test 4: Wrong PK must fail ----
    print!("Test 4 - verify rejects wrong public key:           ");
    let (pk2, _) = dilithium3::keypair();
    match dilithium3::verify_detached_signature(&sig, msg, &pk2) {
        Ok(()) => { eprintln!("FAIL - accepted wrong PK (critical bug)"); std::process::exit(1); }
        Err(_) => println!("PASS"),
    }

    // ---- Test 5: 10 independent sign/verify rounds ----
    print!("Test 5 - 10 independent sign/verify rounds:        ");
    for i in 0..10u8 {
        let test_msg = format!("qnet_test_round_{}", i);
        let s = dilithium3::detached_sign(test_msg.as_bytes(), &sk);
        assert_eq!(s.as_bytes().len(), 3309, "SIG size changed in round {}", i);
        dilithium3::verify_detached_signature(&s, test_msg.as_bytes(), &pk)
            .unwrap_or_else(|e| panic!("Round {} failed: {:?}", i, e));
    }
    println!("PASS");

    // ---- Cross-verify: Android pqclean C -> Rust pqcrypto-dilithium 0.5 ----
    cross_verify_android_pqclean();

    // ---- Summary ----
    println!("\n=== SUMMARY ===");
    println!("pqcrypto-mldsa 0.1 (ML-DSA-65 / FIPS 204): ALL SELF-TESTS PASSED");
    println!("PK=1952B  SK=4032B  SIG=3309B  FIPS 204 / ML-DSA-65 compliant");
    println!();
    println!("Android NDK : pqclean dilithium3 C reference  (CTILDEBYTES=48, SIG=3309B)");
    println!("Rust server : pqcrypto-mldsa 0.1               (CTILDEBYTES=48, SIG=3309B)");
    println!("Both use the same PQClean implementation -> byte-perfect compatibility");
    println!();
    println!("Bouncy Castle 1.75 (removed): SIG=3293B (CTILDEBYTES=32) -> INCOMPATIBLE");
    println!("Old compat_raw.txt chunks were from BC build - replaced by new pqclean build.");
    println!();
    println!("Cross-verify status: DONE - chunks from emulator build 2026-02-20 embedded above.");
}
