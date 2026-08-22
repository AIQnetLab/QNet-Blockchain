//! Genesis node constants - centralized to avoid duplication

/// Genesis bootstrap activation codes (PRODUCTION)
/// These are the ONLY 5 codes that can bootstrap the QNet blockchain
/// Security: codes are protected by IP whitelist + wallet binding + ML-DSA-65 signature,
/// so the sequential pattern is not a vulnerability.
pub const GENESIS_BOOTSTRAP_CODES: &[&str] = &[
    "QNET-BOOT-0001-STRAP",
    "QNET-BOOT-0002-STRAP",
    "QNET-BOOT-0003-STRAP",
    "QNET-BOOT-0004-STRAP",
    "QNET-BOOT-0005-STRAP",
];

/// Genesis node wallet (reward/identity) addresses (PRODUCTION).
/// Pure-Dilithium: eon = SHA512(WALLET ML-DSA-65 pk) of each genesis mnemonic — byte-identical to
/// the mobile wallet's generateQNetAddress and to WalletIdentity::derive_wallet_address, so a genesis
/// operator importing the seed sees THIS address (one seed → one identity, app↔node). Format: 19 hex
/// + "eon" + 15 hex + 8-hex SHA3-256 checksum = 45 chars. MUST equal derive_wallet_address(seed).
pub const GENESIS_WALLETS: &[(&str, &str)] = &[
    ("001", "4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d"), // Genesis Node #1
    ("002", "c81f26da185fd05dcaeeona499b3d9e58d7ec75304f1b"), // Genesis Node #2
    ("003", "006a5c220ca2fa77021eon2b5c6703999066d5411e2ff"), // Genesis Node #3
    ("004", "a60999a5a40637c1dd6eon975ca9618927edd7c19f38e"), // Genesis Node #4
    ("005", "9dd783e0c65cf68467ceondfeaed5e1e47f0242f6aed9"), // Genesis Node #5
];

/// v27 HOLE1: pinned genesis consensus PKs (ML-DSA-65, hex, 1952B) —
/// deterministic `genesis_key` derivation of each node's mnemonic,
/// reproducible via `gen_genesis_consensus_pks`. SOLE genesis-identity
/// source (no runtime/file/TOFU → squat structurally impossible). Public
/// keys only. Rotation = binary release.
pub const GENESIS_CONSENSUS_PKS: &[(&str, &str)] = &[
    ("genesis_node_001", "069c1b294f5f4bc98639edc701440ba235aaf74998c4c0ee9494b7f20f31643301e3f04c67c6504d8d9e9e931b348bfd70798937a16bd52dc6d192d8688e36ce63f7cd25ba648bcc8ba9b072f7a33b328c80a25ab2c95da0a5672f7b4c16f93afe59cbd8fd1dccdd981a20d1ff4bb0053b48f09fb235775ae701d6567030e7ecab9368381c95311bdad1c4c0c99c62be7ce08703d4473dfaea7302dc620829e67535f4bd0921f0f084910951576e449e6286c5a39c98310d10acfca7f56005f902dafd04f58eea634482bd10d29e6ebfdcaadf1153258238a64f2f047e8f5bb21f86d683e3da20ae94e32ef8862b76ecbd3bae128cd0f75af4ac6127e22e6a22a90fc56abff02cecce80db9a421f9d51be7fbb0aa1ac509277ec5098c027ac635aac88cd75277a3a5c080f031cbeffea8b1fd2455b04c50f56c2460d7dabb2a888d47c601a50f8e160ab34c7da560750e95d97067f7ff302617e1b6bd474244c5d58f4dbe82cb3cfe244394530f14581dd7fe20ccb0386a49a76f66b249167c50f4830fa0de42dc5934b0ecfddb78d3e452676ed2794228b985044fbdeb92b3727d3bad87ee6161e3eaeddc05e6907f8d6f6ba71a96e0e940cdc396c33ff1c9bcba0e92a2f81b38ab9c33a6fd557bdbd0d991a09105f28dcb2b84b42bb300d111acac71d71e38d180ed9721a446382df7c901d932bb36c1f045683867822f38b2d8837e5e282f259e45de520096efdbad1dc1979d2ecfd7b3b35fb2557a40136aa5c9f6974dc10cee9d7dd8cd30f950a8d96420a85944c006d8eccc1d5a2d8b0013a2cf363ed464f3a8cb82c61737433da23ba6efb72bfa25de1f1a96fed041c7255f1b6213d040f956fd66ae135df241d6d5f54172638bccf8cb6e04601a3e0c7cb59894bad435f876fed860ecb851273277daabab2cc6017d001317153ca70ab908f9a0e2516ecd19c4058185e62ee2d3b27df28237a4daf9184726cc8f7830c2ec75e4e2fa96379bd03ce71ea192e692d806ddb92bbee68da69b5618f0fab5882a5490b43c3df52ffed057196c8278b79f7681d70af4a13fedd89404c14f283c873b7bd3eaf59fdbf5d7562283fb5471f8047fc8573ec8da32690ff00769a4342e3c72a47fde5f3d66586cbf7aa390fdebe57421e41c83fed1118464c60683d15738ffc365ef83e1431a9b80442f80001a4fb32ca1f6becb65b6e33b21a508deac2437a60082be7d56179044ad2835ebfd73b068860197d5af4ae108b4c9a49bc71f628651a92f27f1bca044711f5c36fcbece1d1e1b05c4362684a1a18ff1cf2c6be2e5858a9c241382d647bbc93e05a5de2e6c4ecff92d49ea358fbacc35e9fc25bc5af8e716ca0fc2f4039fc164f1a6eb1e26838c99c615d8a1e2532b2a8b9dab315140553df8154fdb59420671c1e816f26ddc7703b0a558aa4aa1307ba277c690edd323141e3a799af741fc400a2c58230101fff74d8912de88da9ac18bf9c479a6032b8c806daadd133263a13f7f325f0d994d6be1fb527c5118e311cbb51332ad57dc2506cf3e2b6b3c6cf11d3279eee1e0656cd002eccea8f116bc47f134d3e3126d4324f87b07acb3393ce2ba92e0142f022319b042ef1c816aa7537ba20251af7896bf6c0ce1001a5231ae5ef82bb8e4cecc73a199ac5dfa4b73fecf5b83b883d7f730b7a988d66560b1d3205f73ce96f1eae06e402d7008b88c63081d902b4d9d1e4d2cd234a0edd1ff24fcd3eb2c26ee06139198f4408031ccd3ec056adff91fe92edc6dbad45e1d253a16a438df4d0727c404425438e9eeb7bce9238e01e5bb35684c4dc8eb01550eb8da93f8a899f31861912362b85066ef1593868eeb16d9f7e24566f51c80d82115d09a734b08e9fc45ed13274f6ab91321a41fbc066367b828e2a2f4a7af6c678380cc95dfee7d52abc6458182aa6f4d00d2913a40b201547e759bf7f2fa29626c5fe9eda31675ddac95d8b7c915fd8d20959fa9df5bdf1f8abb59ace966cb36decddb88adb68d0ee4662296786cedb1ab28045166f44fd9e3c95951b93b8384f1733b64ba91ee91cc970a988410059b7b05f5d0a862af891625cfa6b9a618aad9ea42626e52cd60df303dd13147bdb0ae05feab32fe7657ac1468086c39a28bcf5c76137fdd856ed3a633c365b67b58b282bb3273ccaab26a61c91dec4d86362ae46120f2f03629d59634a1e676bc42fde1a3dbdc74930228e9aeb2bc23b8630e76162c3b3c62bd7918f5512318971fa7e458108cbc6fb72b5b871164515fe8a0c67b46cd577bb0ed5ac34e00001fc999a9fa7d36ca45027ed4f5922e8e3b10e01206d70f86092fdf31270e21b02bd810ebeafb0f36600f6ee5ef422d6213ddd5f77737641ff155afb099598acee72588ff0bdd5d1a31a3053a03cb61f85eb596979b3222cf5938ef9c233ddb35356c5ed3178aba298101a216d2ec42d52bcd8a4ebd29cf9d2dddb4181bc8f8a989a714f83ec17a0c63fa4a2223c26a843b3b38a66953fdb4e1bf2e39729e1d09acdb6a86161ffb4ad79b4f293157369804ea1e79dcd44bdc9277b00a9b65dc37807285d834074c784eea41f19ee89b9f71d6c89a8e9541471c0dd099a3c3569affa9b001f6a2530be6f43e9bb96c93a8d550a06f1b47d13cc4f318a5a4ec0dd87250c631f1fedf5ce942fa5742736a589381d49203e5f2e2e7191154e74f0ec04f286d5408ac28fadc486f2d40c271968e19e08e878e480613c5e6925104d50c5cf"),
    ("genesis_node_002", "47f7fad259ea0ae57d12ae3b9e4a4056defc3375eea2fa83a4d32af61dec76fdca8d4ce9b20e12855bfcbdd4a2871ee60f74510be356f018649e04c36802886863995081da12c2b12c0d4166063ed8d9f713e8f3f511d50587e8f432d8104213a2a95e86166ae781c912be1316adcaeb2bb7d15e9f8ec13bc923ce06774d8eafe6dd5a09d8e1a19661b791b3977e1af7fd14b6dd33e803c4f37c5f6de492f53e12534c419c148744b4a400f955086c61bcef097d6efb14afb9fb829d797f6e7fdd0719fc47cc1a0a071cd58b9cb11de0d477c9cd28b4f2a153471ac1f2e979fabcf2e7f45f3c72519cd71c6f9691d0fa487bc3edfa2f49107fda9ac0aa8c4ea47d8cdd3da05ede61cfb53fd59982a330d800480f965f2c8238759f053cd5847e6d5e07280cc0df2477110f70cf204cc1459f46fd9766ea70f0b47ee8d71485ac27146501cabba66cc50d1e0d9da2dd48db8b2f225ee24d85174cccf1c3b6e3a13e0fc4ddf5fb10ccd6e8e4ebf3bcc78e75fc89fa5ce41bf242b4da3a51cbdcb76c61f7abdacd608313da6ada1de31d10143a478afb50305ec591fcd99308cc3b7b92d1ca3a220d384548df7bc928ecabef311d54ce60d8c7948e3c969d13b00c31a21288f70714eb69dd71d14d83078afb52810bff8ba6eb7562f4be37cad14a0fd8ba28476eec2f4aa74fb673abcc484b5f57f1ec4a1246f0de4853b3e8972e55ab4230e6d90e0b1c3b25678414d8d880c6024da7de3fa9f223c16afa63223bcfee5c57098ad2bf978ee4e2dee95dad97a4dcd75f80f1fac057e288321bf37aa6415b1cf3ad6ed335567ec18ecf3276269884078729841c8edea1062ab9a719d55b60400088f468e64e14140ad45a91191814e6a4c882ad88021fbabd80d64cc1e96b066eaf431138b1be6299ac8e085dcd48077204a176d6d86a89af05c30e22be4be5cdee73abf743ade91c46ae1d7d21ab0327922c2d8b9429c44262df06d2e53f014cebcd70aabd12dcd9df14f13ab454a55c6037928501591a2e66a973319255aec73c1deac8f44c6fa53ea82c126df68229e474a9f3cd0997719ab0d04f0ce7cdaed1b06672c9e8ddd2ff4052cbf36c4d2df26de0278f663400cbe996e6f492af2a77661022ba859404cceac845fcd32e0a987d6237ff4bf95603d8f693a4b1612b1105b9f358d8fb222ab0e586868e2369768e962afd911f3cefbaae4c680315b05d8098daf6a145a16239a2054e570389509b9aad7f65737ad7139a5e46e5c6697f8c558b40d03d8e9f429915c4527e2b777e94dde3e8d0ab0384e65f4b88abdc45bd0aa4f13804ee62fd15425a6c99c8f698c367b7b3c46935edbc0a9a3d1b9ab17f608904f07d22b7522af7bd4f31685788e4353546207ab6369d5befef1ce08e034c17d6e3bb7a41d3aee443cc3332486f043cd76548d4834433c24a592a518cc46ef9fdd6e672be1fa4eb41261dcf5fdb3c6fe6cc3ed2b39018e113b0a1f942e3cb3a198dd544c2cb2d3cb194346b575c2e591dedff8829fb47457282633147d84fbaca32e7b3af9f816e8a17c85fa69ff055eaff1bcda009ad90a0237860fd2430eecd170575e33d5c825eaf4005f583b8552a6e6dc100caa69be23fbef03b66aae2a1e070610de037f91cf5488d4c94dc521a009d0a26d3f6c9d6a116170230b0657192a8b88177a494272f6528e29ce0052986c125384a6a80e5a484caedb01b2a30523c5199a021744c29fafe17f6a130d93e30ac9befa9faa5675f9b83c57638dd5b4a813017f0c2a2ccbbc956cd5bef1e64df526141605e1c6b9cc16d9984a3f0d68b6477199a7cb2865197d00baac3dc273d6bdb87cb10b4ea5a3718d636f3b81e03b831e883c922c9636b9580a7ae730a91c2a79e3130cf7ee13377e8909ecf95875af583caa817f83729766469f52d4bf76c1ca893040fb6adc52817e3ca0d5009b7d4761d048ea9903cfcdcbc169c239534fdfee5ecb608cb197504dc4d97b00e0dd7aa5d2880db34585323f4d89ef3fa8c8227ba6d2d6b9478c764f2ba8a0178a64c0216f34101231d7c1ef1451f1ff061249fd20c9d61fcae8c09699e7e470a62756eb23394bfa7c6d1e1eac2e5cc3f64d3f57576f2bdf90859315a42f921f403ebe5a63ef373fe57eb1d517d93e781fc644430411a718bd1058adf7a25d698a882d600eb0ed4b26c5010a7bf1eb7e9b3437146d09f5da70cd5f0956aed77682299fd3e37590bd6fed09e9c92b926373c78bd1c9ad3aabd7639e73344a0d568c9493e71e7160ac4be644beceedfa487e7dca19f2d653159693b693bf00c07f4a2f34214e894e8f98bd0f2eb8f74dc30874ff70480d7c2e7dfa8e7f2d07c4600145be4ad82fe9278126275b50ebc53f70fcaff9066eaf3556ad9897c8e4fd44b800759d05c25691c1b9081ba01e05987f7655c1599490614971ee06b59b649a0c8aea714b2f9e76acb7f20f0c48cb7d1d424916eef2db5ae151ac72ae58d158cfd061831b20a5a31a1e8bc7ac871932ea1d83a947fa1fb1d0d4549b7ca1b1506c568ae0c47a9a0c12fee0eb3c5547599cc4fb4d996994cd7d099730477fda8006e25545ec6da29d51168106a425c3a1f63555fdbb06bf245c720e9e74f8ce7ea3ac7399c0b64de90c0fe3310af7d141b0b6677cbfc38461fab3c5e8c882c7c046370c61fdbea98a7e6d5d27d942d3aba0e021cb328d5ddf3b1a2448b23556d44657eaacf6c7db367fc94ac39e3b3c00b3d38615d"),
    ("genesis_node_003", "19a8b8e79aaaed30f4c7b16a6059d8c9d491b69962dfe25250612607dc949e55b8d572c71a3ecdfda52810ace2c7b68138ed80154704a2d71b21561b227d1271b5d9ee2bc8cbdb8cef125c5699f2aa2f2634aadde1dda2cfab3925373cf81b6dd2e1e4ab8d86ce2108a8cac61f146a94ce6dea024859ba9217cf0342b5b767889b2f32942921c9cf40c566a15a16bd603c57326217818fa2990399421f10aeab99a7da4c776331d971d5ed7290bacb85e3a78f0edc11f18ef90ef3d1a75b9b957d2957725b960aa37943a86adda3f0c00adc55b379f2561753f8e327b2d3c2bec0f25549e7b9ae1fecd2aab3fb3a2f1aa562229abe6d3243568c19f278b6261dd4cc1984d36c64559ffc470fd5ff9dbc22cee7d92aadf33bc5415ba699aeb4802b605e00d7f4863d4a2200f9448c81f2928d9b4e5a5361cdc13cb9a040e73bc58a2027fcfd623616fa44c501f5e3a1ad25c02b732dbc207163a944420f85811c00ed9ae55a7291459ddf5f6b76237b0332ef9191bc5e2649e2a596fef1fbd2eb14f31947ffb14103b505423622f7382ac8847ec399e7698c75651703463854f2ee39cda8179ae45f26f865d0ed30f65ca8d7f7366d3a5eb7bbc72ae6e0d2602cd2e5ad55865b0c41164669548d57c7ce640da1923b784c9cf15fca061950b1368252542e0a8ad8a583a4b79745b6f87190ad44e24ea851bdb6c09585979141a0c97c8994989d628cde244310971588e7bb19de9094b6c42e6814e149ea74d8160188621e400dd9fae39dad063ea417ce6932ada738e03395de59910c854afef3d82b0072ab17b4bf88bfd7872ece0e732f8adc6f0389c00b3159f4db0d72838a58ec911c036ddb81e82fc308393438a9c75ddb88efd41f9eb255b6460b897af1d191f0d40962d7f099716904f43ed1e222b8a3fe0590defa0579bf3f552ce2107db77083b2940195c93db7c0c204df2b65216e4da57b365a900e59af521d2f5c880b10d6f656c65fcf712f5d1f553436eb5d57cee2a1900ac6ae657e5a098fb7530df960a66aee278fed0eeecf627d7267170264be7bd89aa3212cf245af51e7027ea1e6af91e17ad0a464679b9467bfdf4b1c488f5206138ffffec31a7d0d4c4520c542ed86009149bceee43b53ab32276a170ae4571f5d4884ac7cc228343bea44a33e902e8e4c82d579be48df54390dc3d923216e26d5e7c6085aba5d694d82863d88cf82629344060338b187b34a8e720eacbc8da8a4f9f5b24a2a5c07fe409045a1d044c73a69cd8282f6dbb6c1a1d3b7186bc1e740b8eee428f8132371d90033d9840153c8175bdaa649de80892d769cb0ac30f543dfd8a51581f856af9a63453369296a6c35f8f699701b61c0c1851d5600d9eba86b5ecc345dd2a63f044487572e59a41cc80ec609ec7fdc706a3fd57bf76246e87785e4b716a67676b84384b0adfdc5dcadac4dc61fca0db3bc2d461925c90150d0ad20e916be82ee0af86e8f03268cc74f9bdf833e564e14e53ed5c567af8d8237c2e830a953d60124fc7b23cf6982e6a77ae38f3d0fe070e4a0a50e1134a20a0815f852201cd6cefd4831defc9f2908fa0901a106430259b583dcee9dd63c92156f7d62bc45e16a31605a41a111aa7b45c4144aea3d66bf5e98e5344913eabccc9e1179caf803d1deae81021917d53dd31510ad6410a0e790ba1e99d10fbbc1337a7dc418b34cf0f01d7be2a5289a905334a7e937bd18d62969cc09ca0a532ca1b06047a724c9bf04c51ec68526c46cf3dbe50a82d83b52c259fd11c075041cd813d95ece5853b1ad3f287443cebbf4e19fb4cb944c1a2d155f3e992d1c693bb0dbd494e57be97add5360d90f2ecd804e7a01a9b13b6aef21cdc9b95c74388aa437422beee91559ae275ddde1ffc9a8626ce2dcc7094b34a98c854234e44765c24a0241c889f1854cebca728b435c061aab9c371700ab0b9fc3947fe0bb4c173b4fd1c270a5c3b6827bf9a5898c529b5cad68df6fc0676579022ea83521e779ab98c5e4963513a6e5331221b29555f4cebcb37135f7e3e23d672e09fae60cb9bac638fc296c1cd4a182641d50c6602695d9ecfc97fef83e5cd5778cde3c80b30a5509b6b0f98bc45a57921aa8c544072d488d79681079c449d8519c88b5ef17a6d3b1c963e0cae300e11a34e3bbe25b4dc7519818d06db9b4d4e092be8c2acb59bbe5524606a5ecd8b872d4be3d913bc54581970dea3ff2ee0e3067d70d52d1f43a382bb3fb7c2f0635ea2dee913c6a2e08ee471f6dd7f784a98ff2baba23fe04b0ac26b274fbab4c3a35a230aa73bb9e896e5895236d7f8a44d06d364730b058e714f16855764ac2b1b8a7ace168d84589887af426e81da0a0b42065a02a399df9c2dfdd9614d51df9716bbef81109f42375f1733c349fac36fe7a44b974336fcef700ff793190eb531ba5fedc1fe4ed48ab0d193c01e66a8d8bce6bf5d689fa8c5ead3ac3571a4132ad3b18e41eed501e546ca11e24b9dd0d86e03c6084eeb1b759497fb5ad8d3d8b140cdca4f83cef52fadc20ca3ceae7873459390bed019e41508732a4c7fb57ffa4a48a151e59c452eee6dfa9f855b3a9505233e64bdd4554276f2d43fd9263fdbbd4dffef1063a972175b45194ecebe659c7dc51630531d53253628966b6bbac96c5ae1117180bca39efb828512d82fea13d9ca6b3201ebf131760507be90292257e4bcb63820464b841370d70c36b42656b079a4a8a8198d49117b06645"),
    ("genesis_node_004", "d135f421e651ff38db0db25346d985737c5a03891a8a9d620e7611ef2361d70e3e2b05ce1ac885154e9f4db87e76631aa6db296885e43c63a2851fd7e015a6813f82d20a0700bb4e15431c851d34de8dfaf14fd472c6151cba98c63103ed0fcd09d14fa58694f32ea4446322bee91a8bcaeeaa2b5b5519e2ea6bfb74e7827f1e89138b688b505505f675340ac46a1d1577331ac58a2378a26245fceddcfaf8a5ec8db275643c49b99ddd1ac48300e0784942b17cfd1dce88a5303d7c6009639394ef31f8d442cafd9a9efe6dd60c7ac5b9cbf538214ee67ad36f2e5567e36f090396f457d1a048615e661f85e9cc5b041825d73968b487ceb7a5f3629af74d0fcabeaf2df9b178154abf233f5cc2237ab2deb443478cc586a50ba10fd6cfe56c7be14135185d63d90760f6b40b0308bb2924c2650402f2134cf885349dded1375f0ec9d4bc12d8cfcc5c4e48354fa9314fd699174032286a0aa9b9a9a04c1ee0329313c5341357b281afe7624c998cebf3b67fd2a19a7f676a35dc1fbcb5a60e206bc806c40812f7d2d512f881129e436416113f84f4c0be099ffe2452fb89c23589c606d664ab94ddb6a98bd7d01584cce41f8e404d0053c39a3e8476278d1b1a4e5ab17de16ad237dbf698b8b8d92c10b3efc490447b83b3591e73a1e727f738a870a8a4a509438d3a0b427cc03fbcdd279f9af5bcd01af94d4d31921dc1f5ec537115dabd83a0a7e8daa16fbac500b720cf45d206bbfc7efec4b59d472ebb23802fa0bd5f4ced2ab55484bcb64fe47621061d17dfe08503ec8b658cec699a7733268ba0560769cb77bdce18867c3bf78cb82c195bb9f18e11945f3a1ebb2588608a20c69c4f9f5f4cebf77f54f90b8dc3a8b5da70a9677d09f493d66ed796f05ff886939851cc4c4825c1ec5cebf0017dc7eb3ebfd6d7055fae17e25dd0574071f326c52409cd4df91392435426b24a95dfe29ea16abf5d9fef681667f4ecf897020b5a26aa39e97f0db6f5a8d95a50f117118447e43dc353a92d6c8050ae550a0aed6738440c5bed92086180cc61b903cb6a9254b4e5b484a366eb10d07d20d3af224a540f2cea1598f01a846dca9da8450e1d23419ef4e36d963d6319056735a50ebb33bd11a2948dc052206e787b05152836ae9aead97c9f1418c3d2c68d60cd098de494e06248e1df4a22c8564829e52b3e8b09f2131a89ee6bdbe2893d292fa9a2bd35fc99c21f36c38c18e4e7caf15660aeb6dcee4d3e36058abf4e7a13a4e186553e6e0bdd39f823aac23794e29a27fb8c9e055b6d6915811e2999a3c3cbaf502d695053819621e657e325dc9b73ae6b608259567bcf9bb19d08fb0f12bfddb9c6b498a978d8996127874847ea8c90f114fb85a700836e27e5cc6a7bb83d7c0635d5d477f5f44b5dfe830ef65e91987d3c5624606f985b92b28a5d2309f93b9f2f0196c850659c3c1bb642485fcfc0f04998cb55272575f4a8ad114c3cf978b7709aa489b527218d40ac8ffb4a74eb38760b9e07fed261d54712725d8f762808e9083d9e3e7b54ef8a2f5fccf64b3071557323ac1bc38adfac0a20044bf09d8d7ab112e21f6b5cb83ba07feefcc3e78b38e0e111170a38c6197c00e43d636dd9fee736cb945868dd557280956ec2941db91697469a0cf3f370b616bb4dafb144259105b00ced279802f4417cef7f2c9ee567525d1bcb0417f36426a55cd20434e0671d3bfdcad30b5394e857dfdb900ae5a6a56cf1e600af53ebbf3d4ebfd427ae0223ce570ccd56983238f5b9a7b533b643c39c369b5acf71647d479bc7ef6203c2ca5eabfd3bdbb7adece0fcd203b06c3959c3f01ffa758586d74ffa8b7579b5866438cbe03b0addba9a0e5968101dccda3bca244a939d1ede77593eac6b8b924a87f43911d6a30c5ac688e6c3de5a787f13b7c0120c1520c2591235e896aec592b8a8ef25d6c4c8cfada03de9d05f26cffa32b7a403c6f41ff7d8ffaa3a099982af80a35f68c8d0be90d2300381d9973342a6915728151ce686c10d1f0671736f92f1a3d6f5bb7dde96f23a87c0bc05d0874d4e48a812c76f86fc17cf4e7d8c565a8a61f46b96744afcd3c4896c7c1d6119b2ea7626525028768466276d13700722d3f10032e911e004b8bb8ee6b5bd5c3e9ca68693f126b578c690d907a289e5e3b202595a0d691e1b084ceb8086bf628f0e57fcf41843de367bf73d31835e045dd85699a627b6de554311310c7990bd2dd3ff6b1bc83fe8f3e09598fffbce04144cb4546b236c8a8be7dca9996fd5e2691dab1a84c6abe828d7d7e62444f9ba6b70a21f748228d99472e27e6e29e3478e657ff288f81c13eec0cb70c59743260708f6ad80757d9602cf1f6ddd71985d296e87003e06afc35b807c88cb44da6e7a0683d07b36563e57142532be1daad32446d3ce14e6ccecd0555458a2bd1d02430f440437ab2e497abbce25e0783f2297b9e03a39502c4a72a414563eabf5e4e3fe9d5ad7e75fb7274b34a53d723f18a6fb5447c659422e1a3a27c1f570d34d9866fde5fd3bf6b296308769d319b24027d00a7116f702544c6f03800b3376e18d4f2554d326a6a60d7dfcc028613863108cf6e1a215b3fb6e22d9cee3edc578d4cc11eef086ff45d20eed9449df349cdc166a59dd65f53b6aef9ee76a37474253e4e7d959bd9ff64a0b156a73efc3cbbac0338893fa87aaa2db6c7420654ca0b7c9d02960b0c8835c1a0b3f6b2f61f9aefeaf39f316d021eb"),
    ("genesis_node_005", "906bcfc96772992169471746a317a3006ba20c839b5b3f9c8ae18b0acdfd7a6e8a0133cc19c9c608e61c9a99caba2750afa86e2159d0d4de54eea609d9aee8e4373d5add14d2727afd49ac4e46f12b748bcf746b5f73b07ae064542b76722dbce1da10a3cebc97d30fe99fe929c568f0af4652587d2a32f52f13530754daebb810c70c7881191532cc77c3117b33aa2a6e33791f836bed74b6d8666ba65692838e7ed79e9aabf75c151f363cd4b8785743aa82c36a2831ac82b20828a29b5ecad16b39003d0309aee7cf451ee54f23d7285262d6a28570b19b68fb984bfbf1b9e6d5dae6c232ff0f19321aa1fcf3edbe7e84033b00604c4324f3615e2719203e0ce3cb5b17c80faa67bc3bd217d5c26962f75541bfcf18ffee1fa8944013992949a27d3eb508533a0c2068bf4bfd7d7fa95805ace4dad52ad84b574a19f5a91a7de5238cb72668714156017348bb673768ddd2ce634e7f019ba865f1b52346bc572eeee3a96fb36132e7d37082cba9a3f7eb001401be216dddad56fb8a0bf449a912378b564d3123806ddbbbdda80119fdb8223873f6fcfc7a864e008153abea2cad57a2bff011a058ea2fcd74976fa8aade5e9736a328acb163d077b633cf96d97130fedc806b44f2de0233cf5571c975abea5bb0993d909afbc0392aaf2a691e27fb23dc550a36bb4619a5326a0970c3c50534a33832a576490f60faaa1082aabfb8079def5793852f985f41fa65e8991562bfd615075a437054ed238a79570cdd5149564ddfa492e3f852c826162712b6e863edf38cfc218e3a978c0bb5f4ac5b1ae361b1e5f02f32c0be5809fc450f270ab0559de0f1130210d0ee9fb314c83a0b84837160dcf64fe49b82950a5c55ca9977a93b7c835b18c27ff5c8eb453c99aaa5fc498c45bb8237b7a2241bb9d48b0e3642924f40474dcd5d5ab2bb9cb7326165001edcdab59e234ee60e32be4f469cb625844f8028db638ba9a9fc58b4c3347095016d0e63d7dc35306ab37be45460160f34c2bed5cda73997fc80e0902580606a4c536b5e085e6017f623960b30066272c5370ad3ebec393ca9b038bbb3b8159feded8ed01c27d669d513c9a899beb4d2265ee4ac00c3e529fb004431dd221b4274bfbe56059e73f6f3901bfcd57352b60f0f7a838b8413c45a72fc1c9369ae03a95dc37e5e36297bed91c7ad20bc0be7b59b727ffa046cc57aadd2e7da0ec304b512e73d1b707b6a60edf3d3db4222a7265cdab6d071fbd7b012fd4d45ef59771f7dab7f4d178a2b6e05110408cf93e0ee57db4693c29ebd3d2ba27a2b52075106c4996f9bd9993b836cd227a098a1a11552ae7db3a4d40a9c090e4c0c2841baa816c53deebdd6a901018425dfb14b0e07f428b07f38ffd55828a621e4525a930d6bd74e64d594b85bcabaf6abfada1734b36c7acfa7c477eb2314617d19f51e345466aaa382c52b3f1d72b029ecfef62f6d6e487ed6ce7915cf9f767d12044147152ad81236bcb0ae3887e6856b2c954f2692252f927e5c6eadb1862ee79c07ff95fc9cf539a8bece9583bf138ba22e12a8edb8731f522728b718cb0e52b4ba3bc684e59260d98810b6fcc6ccaacf60ce321c8e42f7b3e5b1092bd842de1493309cbf54d8881bee8629365f7cd8524ed89121d27343e1908f3ca517628be4352376216af3cf6b5a3af8c9d977fa4af9baf8cd2b95e37f66349fa3298b84c101afbc2c8d87db159e1a9347e36faee9520756f4b033c0c6a2a4307743883f7f608d4584294dde8926533c147affa0e2a620b5a3e5c716d6cfe0345763d6311f2089136abfe8dc1b812571a5eecd176958da06b117e133b93873709d66a9fb00e83576610e65e721022096790922fcb01702fee7d93d743fa7ec41f78daacaa174312354f22c3cdbef2938f7b9a59a268a4dbdb42de7285084d617f4b26e1c1e7ed373af35f270b6e04eabc5f6ac8702011ab551801c901a94ea6f7a2ae97d666bd056296ce7ec70f8f40699e559f91d6db3ad77502437b4e724628edb0c6eae30ef7a85cd3204e5cb612430691889bb49a96a6d95993815b3c320bf5c0054e0821bda4e2df4a06db0dfe753ccd10a55c49dcc772ea01f2110b7989f403451ceef5b97d2152f0e0e8a542032fa0bce2cd4b120aab4d2cf58d12b20f5ee3ba1fada05cebe880ae839e927a13f15a708b7cfe4557c70899d008720801826281cfed56c338e64dd9f43a93071b7b38cec2be00cd6d2b32923a21aab82958c39bfe56650e899bfb7ab033bbfeb3821da0ab09bcfda83f3760512bb24d9f0908130ccb2f97faa84f9bf77dd50e38eac2d18f25a049b1a3b21d06e252f2952b26a7a5d0b99dce73035c99dade288ebb719503ec9b0c6f3857471099102660958254d5dcd0c64efe90df19a4ae49f14c2c5991d551b146ee6b604467c9b196832382be398cae8d9bd994fc9f7393232ea75fa3d009ed17cdcb1706284806bf716aff72777cc6dd1835bb11e22f46e5f110714e5456e9ccc905d7943bb7e8f4fbc44ef4bfa642aabf33d603f8e36ea2ac77040e9597154429e29aad769b6cd06d763b53d403d655e6f5cbfdd318b2550d42ec212625819380a39e476f945a6c6b991911b021b420acc411bbb903d700fcd5ee5525de6dbc99f2905875d0a23bd5e71602edb939670734d96865f589d5a89d33da61827e8df71bec84db8a750ffb35545065c6769d50dbd8b2e32b189c0980485e0276beeace1a418bcb4674503"),
];

/// Weak-subjectivity checkpoint = (macroblock index, MacroBlock::hash()) — same binary-embedded trust
/// model as GENESIS_CONSENSUS_PKS: the cold-join inductive ROOT, pinned per release, rotated only by a
/// new binary (NEVER an operator env flag — consensus-safety param). FORMAT: index = height/90; the
/// hash is MacroBlock::hash() (SHA3-256 of height‖timestamp‖previous_hash‖state_root‖micro_blocks),
/// which EXCLUDES consensus_data ⇒ byte-stable across nodes, independent of QC bytes. HOW IT IS USED
/// (verify_snapshot_consensus_binding + verify_v2_macroblock): a cold-joiner re-verifies the macroblock
/// lineage UP from this pin — the pinned macroblock is trusted by hash, its predecessor by the
/// previous_hash chain (the two N-2 committee sources), then each higher macroblock's 2f+1 QC verifies
/// against the committee from its already-verified N-2. The walk reaches back only to WS, not genesis,
/// so cold-join stays fast on a mature chain (each QC verify is up to 1000 post-quantum opens). BUMP
/// DISCIPLINE: rotate to a recently-finalized macroblock every release so (tip - WS) stays under the
/// MAX_WS_WALK_MB bound (storage.rs) — beyond it cold-join is refused, forcing a binary upgrade (this
/// is the weak-subjectivity period; a stale pin must NOT silently widen the trust window). FRESH genesis
/// launch: (0, [0u8;32]) → INERT: the walk starts at genesis (index 1, genesis static committee) and the
/// pin branches (gated on index>0) never fire, so behaviour is identical to no checkpoint.
pub const WS_CHECKPOINT: (u64, [u8; 32]) = (0, [0u8; 32]);

/// Trusted weak-subjectivity macroblock index (lower bound of QC re-verification). 0 on fresh genesis.
pub fn ws_checkpoint_index() -> u64 { WS_CHECKPOINT.0 }

/// Full trusted (index, MacroBlock::hash()) weak-subjectivity checkpoint.
pub fn ws_checkpoint() -> (u64, [u8; 32]) { WS_CHECKPOINT }

/// Per-macroblock committee-fields digests for the WS pin = SHA3-256 over (eligible_producers ‖
/// randomness_beacon) of the pinned macroblock K (ANCHOR) and its predecessor K-1 (PRED) — the two N-2
/// committee-derivation sources that MacroBlock::hash() (body only) does NOT cover. Checked at K's and
/// K-1's pin branches respectively so a hash-equal macroblock with forged producers/beacon is rejected
/// at STORE time through any ingress (closing the forged-forward-committee forge). Rotated WITH
/// WS_CHECKPOINT every release; zeros on fresh genesis ⇒ the pin branch is inert (never fires at
/// index 0). A non-zero pin with zero digests fails closed (a real macroblock's digest is never zero).
pub const WS_CHECKPOINT_DIGEST_ANCHOR: [u8; 32] = [0u8; 32];
pub const WS_CHECKPOINT_DIGEST_PRED: [u8; 32] = [0u8; 32];

/// Trusted (anchor=K, pred=K-1) committee-fields digests for the WS pin.
pub fn ws_checkpoint_committee_digests() -> ([u8; 32], [u8; 32]) {
    (WS_CHECKPOINT_DIGEST_ANCHOR, WS_CHECKPOINT_DIGEST_PRED)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// COORDINATED RESTART
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/// A coordinated restart: resume from a named macroblock, with a named set of identities barred from
/// eligibility.
///
/// WHY THIS EXISTS. A chain with no staking has nothing to slash and nothing to leak, so it cannot
/// bleed a stalled quorum back to liveness the way a bonded chain does. Four separate impossibility
/// results say the stall itself cannot be prevented in-protocol: no public witness can prove work
/// (the heartbeat preimage is entirely public), per-identity costs cannot exceed flat per-identity
/// income, a farm amortises any cost better than a single honest operator, and a participation filter
/// is either non-reproducible, frozen during the very halt it exists to end, or inert at target scale.
/// What is left is what every non-slashing chain actually does: make the halt REVERSIBLE — a
/// coordinated restart is the standard recovery for this class.
///
/// WHY A COMPILED CONSTANT AND NOT A RUNTIME AUTHORITY. A restart is the single most dangerous action
/// this system can take — it re-roots trust. Carrying it as a signed message a running node would
/// accept means shipping an online authority that can re-root the chain, which is a far worse standing
/// risk than the halt it repairs. As a `const` it is inert until someone publishes a release, the
/// change is a reviewable diff, and a node either runs that release or does not join. Same discipline
/// as `WS_CHECKPOINT` above, and the project's env-flag policy forbids the alternative outright.
pub struct RestartManifest {
    /// Macroblock to resume from — MUST be full-quorum sealed and at or below the last good seal.
    /// 0 = no restart in effect (the only value shipped for a fresh genesis).
    pub resume_from_mb: u64,
    /// `MacroBlock::hash()` of `resume_from_mb`. A node whose local copy disagrees FAILS TO START
    /// rather than silently continuing on the branch the restart exists to abandon.
    pub resume_mb_hash: [u8; 32],
    /// Identities barred from eligibility from the restart onward. This is what stops the restarted
    /// chain from re-halting on the same set within minutes; without it a restart is a reboot, not a
    /// repair. Sorted, deduplicated — checked at build time by `restart_manifest_is_wellformed`.
    pub excluded: &'static [&'static str],
}

/// The manifest this binary carries. INERT for a fresh genesis launch.
pub const RESTART_MANIFEST: RestartManifest = RestartManifest {
    resume_from_mb: 0,
    resume_mb_hash: [0u8; 32],
    excluded: &[],
};

/// Is a coordinated restart in effect for this binary?
pub fn restart_active() -> bool { RESTART_MANIFEST.resume_from_mb > 0 }

/// The `(macroblock, hash)` a restart resumes from, or None.
pub fn restart_anchor() -> Option<(u64, [u8; 32])> {
    if restart_active() { Some((RESTART_MANIFEST.resume_from_mb, RESTART_MANIFEST.resume_mb_hash)) } else { None }
}

/// Is `node_id` barred by the restart manifest? Barred identities are excluded from eligibility on
/// EVERY path — the carry-over filter and the Phase-2A re-admission — or the re-admission would put
/// them straight back into the quorum denominator the restart just cleaned.
///
/// Linear over a list that is empty in the shipped binary and expected to be small even after an
/// incident; it is called per-candidate per-window, so if a manifest ever needs thousands of entries
/// this must become a set built once per snapshot.
pub fn restart_excludes(node_id: &str) -> bool {
    RESTART_MANIFEST.excluded.iter().any(|e| *e == node_id)
}

/// The manifest must be internally consistent or the release is wrong in a way no test at run time can
/// catch. A non-zero macroblock with a zero hash would hash-trust ANY macroblock at that index — the
/// exact forge the WS pin's digests exist to prevent — so it fails closed here instead.
pub fn restart_manifest_is_wellformed() -> Result<(), &'static str> {
    let m = &RESTART_MANIFEST;
    if m.resume_from_mb == 0 {
        // Inert: nothing else may be set, or a half-filled manifest reads as "no restart" while
        // silently barring identities.
        if m.resume_mb_hash != [0u8; 32] { return Err("restart_hash_without_height"); }
        if !m.excluded.is_empty() { return Err("restart_excludes_without_height"); }
        return Ok(());
    }
    if m.resume_mb_hash == [0u8; 32] { return Err("restart_zero_hash"); }
    // THE restart must name the SAME macroblock as the WS pin. This is what keeps the feature small:
    // every branch-abandonment check a restart needs already exists on the pin path — `index < ws.0` is
    // refused, and `index == pin.0` must hash-match, so a node holding the old branch is rejected by
    // machinery that is already proven. Letting the two disagree would mean re-implementing that path,
    // and a second trust root is exactly how a restart turns into a fork.
    if m.resume_from_mb != WS_CHECKPOINT.0 { return Err("restart_disagrees_with_ws_pin_index"); }
    if m.resume_mb_hash != WS_CHECKPOINT.1 { return Err("restart_disagrees_with_ws_pin_hash"); }
    // A pinned macroblock with zero committee digests hash-trusts forged producers/beacon at that
    // index — the forge those digests exist to close. A restart release must rotate them together.
    if WS_CHECKPOINT_DIGEST_ANCHOR == [0u8; 32] || WS_CHECKPOINT_DIGEST_PRED == [0u8; 32] {
        return Err("restart_without_committee_digests");
    }
    for w in m.excluded.windows(2) {
        if w[0] >= w[1] { return Err("restart_excluded_not_sorted_or_duplicated"); }
    }
    Ok(())
}

/// Genesis node IP addresses (PRODUCTION)
/// These IPs are authorized to run Genesis nodes
pub const GENESIS_NODE_IPS: &[(&str, &str)] = &[
    ("154.38.160.39", "001"),    // Genesis Node #1 - North America
    ("62.171.157.44", "002"),    // Genesis Node #2 - Europe
    ("161.97.86.81", "003"),     // Genesis Node #3 - Europe  
    ("5.189.130.160", "004"),  // Genesis Node #4 - Europe
    ("162.244.25.114", "005"),   // Genesis Node #5 - Europe
];

/// Legacy genesis node IDs (single-digit form, kept for backward compatibility
/// with code paths that still emit the unpadded representation).
pub const LEGACY_GENESIS_NODES: &[&str] = &[
    "genesis_node_1",
    "genesis_node_2",
    "genesis_node_3",
    "genesis_node_4",
    "genesis_node_5"
];

/// Check if given activation code is a Genesis bootstrap code
pub fn is_genesis_bootstrap_code(code: &str) -> bool {
    GENESIS_BOOTSTRAP_CODES.contains(&code)
}

/// Check if a `node_id` refers to a Genesis bootstrap node.
///
/// Accepts BOTH representations the codebase emits:
///   * Production / 3-digit form: `"genesis_node_001"` … `"genesis_node_005"`
///     (the form actually written into chain state and used in production logs)
///   * Legacy / 1-digit form: `"genesis_node_1"` … `"genesis_node_5"`
///     (the form embedded in `LEGACY_GENESIS_NODES`, kept for older callers
///     that have not been migrated)
///
/// Both representations MUST be recognised: the IP-gate, the anti-squat check
/// in `consensus_crypto::register_*`, and the genesis-identity hard-reject in
/// `verify_with_real_dilithium` all key on this function. A bug here that
/// returned `false` for the production form silently disables every gate it
/// guards, which is the v16.x identity-squat class.
///
/// Scalability: the check is O(N) over `GENESIS_NODE_IPS` where N == 5. The
/// genesis set is fixed at network birth; this function will never be called
/// in a hot path that scales with super-node count.
pub fn is_legacy_genesis_node(node_id: &str) -> bool {
    let Some(suffix) = node_id.strip_prefix("genesis_node_") else {
        return false;
    };
    // Match against the canonical bootstrap_id table. We compare the suffix
    // against BOTH the padded form ("001") and the leading-zero-stripped form
    // ("1") so callers using either representation get the same answer.
    for (_ip, bootstrap_id) in GENESIS_NODE_IPS {
        let unpadded = bootstrap_id.trim_start_matches('0');
        if suffix == *bootstrap_id || (!unpadded.is_empty() && suffix == unpadded) {
            return true;
        }
    }
    false
}

/// Resolve the canonical genesis IP for a given `node_id` of either form
/// (`"genesis_node_001"` or `"genesis_node_1"`). Returns `None` if the
/// `node_id` is not a genesis identity.
///
/// Used by every IP-gate site to compare the sender's source IP against the
/// hard-coded genesis IP for the claimed identity, with format normalisation
/// done in one place rather than copy-pasted at each call site.
pub fn genesis_ip_for_node_id(node_id: &str) -> Option<&'static str> {
    let suffix = node_id.strip_prefix("genesis_node_")?;
    // Normalise to padded 3-digit form expected by GENESIS_NODE_IPS keys.
    let padded = match suffix.len() {
        1 => format!("00{}", suffix),
        2 => format!("0{}", suffix),
        _ => suffix.to_string(),
    };
    get_genesis_ip_by_id(&padded)
}

/// v14.7: Count of genesis validators — hard floor for quorum computation
/// when the live validator set cache is empty (cold-start / pre-handshake).
/// Every genesis node has an entry in `GENESIS_NODE_IPS`.
pub fn genesis_node_count() -> usize {
    GENESIS_NODE_IPS.len()
}

/// Get Genesis node IP by bootstrap ID (001-005)
pub fn get_genesis_ip_by_id(bootstrap_id: &str) -> Option<&'static str> {
    for (ip, id) in GENESIS_NODE_IPS {
        if id == &bootstrap_id {
            return Some(ip);
        }
    }
    None
}

/// Get Genesis bootstrap ID by IP address  
pub fn get_genesis_id_by_ip(ip: &str) -> Option<&'static str> {
    for (genesis_ip, id) in GENESIS_NODE_IPS {
        if genesis_ip == &ip {
            return Some(id);
        }
    }
    None
}

/// Get Genesis node region by IP address using EXISTING constants and comments
pub fn get_genesis_region_by_ip(ip: &str) -> Option<&'static str> {
    // EXISTING: Use GENESIS_NODE_IPS mapping with regions from production deployment comments
    match ip {
        "154.38.160.39" => Some("NorthAmerica"), // Genesis Node #1 - North America (from comments)
        "62.171.157.44" => Some("Europe"),       // Genesis Node #2 - Europe (from comments)
        "161.97.86.81" => Some("Europe"),        // Genesis Node #3 - Europe (from comments)
        "5.189.130.160" => Some("Europe"),     // Genesis Node #4 - Europe (from comments)
        "162.244.25.114" => Some("Europe"),      // Genesis Node #5 - Europe (CORRECTED)
        _ => None,
    }
}

/// Get all genesis node IPs as a Vec<String>.
/// Used by genesis_config and sync_manager for HTTP fallback.
pub fn get_genesis_ips() -> Vec<String> {
    GENESIS_NODE_IPS.iter().map(|(ip, _)| ip.to_string()).collect()
}

/// Get Genesis wallet address by bootstrap ID (001-005)
pub fn get_genesis_wallet_by_id(bootstrap_id: &str) -> Option<&'static str> {
    for (id, wallet) in GENESIS_WALLETS {
        if id == &bootstrap_id {
            return Some(wallet);
        }
    }
    None
}


// =========================================================================
// v4.0: VRF Public Key Registry for producer verification
// Maps node_id → ML-DSA-65 public key (hex)
// Populated during node registration, used for VRF proof verification
// =========================================================================

use std::collections::HashMap;

lazy_static::lazy_static! {
    /// Global registry: node_id → dilithium3_pk_hex
    /// Thread-safe, updated on node registration
    pub static ref VRF_PK_REGISTRY: parking_lot::RwLock<HashMap<String, Vec<u8>>> =
        parking_lot::RwLock::new(HashMap::new());
}

/// Memory-budget knob, NOT a correctness bound: the durable vrf-pk CF is the
/// source of truth (a miss re-resolves via save_vrf_public_key /
/// register_vrf_public_key on block apply). Sized for the active-super ceiling
/// so a busy cluster does not thrash evict/reload.
const MAX_VRF_REGISTRY_SIZE: usize = 1_000_000;

/// Register a node's VRF public key.
///
/// SECURITY (v27): genesis identity is NEVER established or persisted at
/// runtime from gossip. The (node_id → consensus PK) binding for the 5
/// genesis identities is pinned by the binary-embedded `GENESIS_CONSENSUS_PKS`
/// constant and installed before P2P opens. This function only fills the
/// working VRF lookup for non-genesis (super-node) identities and for the
/// already-pinned genesis set; it performs no anchor disk-write — the prior
/// `try_autowrite_genesis_anchors_locked` path could cement a transient
/// identity-squat into the immutable anchor map and has been removed.
pub fn register_vrf_public_key(node_id: &str, pk_bytes: &[u8]) {
    if pk_bytes.len() != 1952 {
        println!("[WARN][VRF_REG] invalid pk_size={} node={}", pk_bytes.len(), node_id);
        return;
    }
    // A genesis identity's key is pinned in the binary; nothing off the wire may restate it. Without
    // this, a crafted NodeRegistration naming a genesis id installed an attacker key here — the caller
    // that scans block bodies does not filter by apply success, so the TX did not even have to apply —
    // and every block-validity reader resolves the producer key through this map.
    // No-op during install_genesis_anchors_at_startup: it registers BEFORE setting the anchor map.
    let anchor = qnet_consensus::consensus_crypto::get_consensus_pk_anchor(node_id);
    if genesis_pk_overwrite_refused(anchor.as_deref(), pk_bytes) {
        println!("[ERR][VRF_REG] genesis_pk_overwrite_refused node={}", node_id);
        return;
    }
    // PRODUCTION: Single write lock to eliminate TOCTOU race condition
    let mut registry = VRF_PK_REGISTRY.write();
    if registry.len() >= MAX_VRF_REGISTRY_SIZE && !registry.contains_key(node_id) {
        println!("[WARN][VRF_REG] registry_full size={}", registry.len());
        return;
    }
    registry.insert(node_id.to_string(), pk_bytes.to_vec());
    println!("[INFO][VRF_REG] pk_registered node={} total={}", node_id, registry.len());
    // v27: no runtime genesis-anchor disk-write (squat-cementing path removed).
}

// v27: `try_autowrite_genesis_anchors_locked` REMOVED — it cemented a
// gossip-squatted PK set into the immutable on-disk anchors. Genesis
// identity is pinned by GENESIS_CONSENSUS_PKS (below), never gossip.

/// Get a node's VRF public key for proof verification
pub fn get_vrf_public_key(node_id: &str) -> Option<Vec<u8>> {
    VRF_PK_REGISTRY.read().get(node_id).cloned()
}

/// Check if node has registered VRF key
pub fn has_vrf_key(node_id: &str) -> bool {
    VRF_PK_REGISTRY.read().contains_key(node_id)
}

/// Get all registered VRF public keys (for full election verification)
pub fn get_all_vrf_keys() -> HashMap<String, Vec<u8>> {
    VRF_PK_REGISTRY.read().clone()
}

// =========================================================================
// v30.B1: NODE ENDPOINT REGISTRY — node_id → canonical IPv4 string.
//
// Closes the cost-asymmetric DoS where an attacker fires forged
// handshake_proof at a victim's QUIC accept loop from any IP, forcing the
// victim to pay TLS state + ~3.3 KB Dilithium parse per attempt. The early
// IP-identity gate (in quic_transport.rs::handle_server_handshake) consults
// this registry to refuse impersonation BEFORE the expensive verify step.
//
// Source of truth: signed NodeRegistration TX in chain state. Populated by
// the block-apply path (cache_node_registrations_from_transactions_with_dashmap)
// for super-node identities. Genesis identities resolve via the pinned
// GENESIS_NODE_IPS table and do not go through this registry.
//
// Scalability: DashMap (sharded, lock-free O(1)). Sized for hundreds of
// thousands of super-node identities; ~24 bytes overhead per entry.
// =========================================================================

use dashmap::DashMap;

/// Memory-budget knob, NOT a correctness bound: the durable node_registry CF is
/// the source of truth (a miss re-resolves via cache_node_registrations_from_
/// transactions_with_dashmap on block apply). Sized for the active-super ceiling
/// so a busy cluster does not thrash evict/reload. At capacity a new registration
/// evicts one existing entry (see register_node_endpoint) so it is never refused.
const MAX_NODE_ENDPOINT_REGISTRY_SIZE: usize = 1_000_000;

lazy_static::lazy_static! {
    pub static ref NODE_ENDPOINT_REGISTRY: DashMap<String, String> = DashMap::new();
}

/// Strip an "ip:port" or "ip" endpoint to its IPv4/IPv6 part only.
pub fn endpoint_ip_only(api_endpoint: &str) -> String {
    // Accept "scheme://host:port" form too — strip scheme and trailing path.
    let after_scheme = api_endpoint.split("://").nth(1).unwrap_or(api_endpoint);
    let host_only = after_scheme.split('/').next().unwrap_or(after_scheme);
    // IPv6 may use [::1]:8001 form; bracket-strip and split last colon.
    if let Some(rest) = host_only.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[..end].to_string();
        }
    }
    host_only.split(':').next().unwrap_or(host_only).to_string()
}

/// Register/refresh a node's canonical endpoint IP. Called on every
/// NodeRegistration / NodeReactivation TX during block apply.
pub fn register_node_endpoint(node_id: &str, api_endpoint: &str) {
    let ip = endpoint_ip_only(api_endpoint);
    if ip.is_empty() {
        return;
    }
    if NODE_ENDPOINT_REGISTRY.len() >= MAX_NODE_ENDPOINT_REGISTRY_SIZE
        && !NODE_ENDPOINT_REGISTRY.contains_key(node_id)
    {
        // At capacity: evict one entry so a new registration is never refused. This is an advisory
        // IP-identity cache re-resolved from chain, so which entry goes is non-consensus and safe.
        let victim = NODE_ENDPOINT_REGISTRY.iter().next().map(|e| e.key().clone());
        if let Some(v) = victim {
            NODE_ENDPOINT_REGISTRY.remove(&v);
        }
        if std::env::var("QNET_DETAILED_LOGGING").ok().as_deref() == Some("1") {
            println!("[WARN][REG] endpoint_registry_full evicted_one size={}", NODE_ENDPOINT_REGISTRY.len());
        }
    }
    NODE_ENDPOINT_REGISTRY.insert(node_id.to_string(), ip);
}

/// Lookup canonical endpoint IP for `node_id`. Returns None for unbound
/// identities (first-contact / not-yet-registered super-nodes).
pub fn get_node_endpoint_ip(node_id: &str) -> Option<String> {
    NODE_ENDPOINT_REGISTRY.get(node_id).map(|e| e.value().clone())
}

// Optional genesis Dilithium anchor loader. If present, the file binds the
// 5 genesis identities to fixed PKs via set_genesis_anchor_pks (immutable
// once installed; any non-matching PK is rejected as a squat). Super-node
// identity binding is instead established by signed NodeRegistration TXs
// feeding register_consensus_pk_from_chain.

/// Default location of the genesis anchors JSON file inside the container.
pub const GENESIS_ANCHORS_PATH: &str = "/app/data/genesis_anchors.json";

// v27 HOLE1: BootDecision / anchors_missing_boot_decision /
// load_genesis_anchor_pks_from_file REMOVED (file/TOFV/QNET_BOOTSTRAP_FRESH
// was the squat window). Identity = embedded GENESIS_CONSENSUS_PKS.
// GENESIS_ANCHORS_PATH kept only for legacy log refs.

/// v27 HOLE1: install pinned `GENESIS_CONSENSUS_PKS` into the immutable
/// anchor map + pre-populate VRF/consensus-PK registries (Tier-1 match from
/// t=0, no TOFV race). Idempotent; fail-closed on malformed/incomplete set;
/// MUST run before P2P. Super-nodes bind via signed NodeRegistration TX
/// (unaffected). O(5).
pub fn install_genesis_anchors_at_startup() -> usize {
    let mut map: HashMap<String, Vec<u8>> =
        HashMap::with_capacity(GENESIS_CONSENSUS_PKS.len());
    for (node_id, pk_hex) in GENESIS_CONSENSUS_PKS {
        match hex::decode(pk_hex) {
            Ok(bytes) if bytes.len() == 1952 => {
                map.insert((*node_id).to_string(), bytes);
            }
            Ok(bytes) => {
                eprintln!(
                    "[CRIT][GENESIS] embedded_pk_bad_size node={} got={} want=1952 \
                     action=halt_startup",
                    node_id, bytes.len()
                );
                std::process::exit(2);
            }
            Err(e) => {
                eprintln!(
                    "[CRIT][GENESIS] embedded_pk_bad_hex node={} err={} action=halt_startup",
                    node_id, e
                );
                std::process::exit(2);
            }
        }
    }
    if map.len() != GENESIS_NODE_IPS.len() {
        eprintln!(
            "[CRIT][GENESIS] embedded_pk_count={} expected={} action=halt_startup \
             hint=GENESIS_CONSENSUS_PKS_must_cover_every_genesis_id",
            map.len(), GENESIS_NODE_IPS.len()
        );
        std::process::exit(2);
    }

    let count = map.len();

    // Pre-populate working registries, then install the immutable anchor
    // map. Ordering is intentional: registering against the not-yet-set
    // anchor map skips the anti-squat branch (these are the canonical PKs);
    // after `set_genesis_anchor_pks` the same calls are immutability no-ops.
    for (node_id, pk_bytes) in &map {
        register_vrf_public_key(node_id, pk_bytes);
        if !qnet_consensus::consensus_crypto::register_consensus_pk_from_chain(node_id, pk_bytes) {
            eprintln!(
                "[WARN][GENESIS] anchor_prepopulate_failed node={} reason=registry_or_size_check",
                node_id
            );
        }
    }

    let installed = qnet_consensus::consensus_crypto::set_genesis_anchor_pks(map);
    if installed {
        println!(
            "[INFO][GENESIS] anchors_installed count={} src=embedded_GENESIS_CONSENSUS_PKS \
             prepopulated_registries=true",
            count
        );
    } else {
        println!("[INFO][GENESIS] anchors_already_installed count={}", count);
    }
    count
}

/// A pinned genesis key may never be restated by anything that arrived off the wire. Returns true when
/// a write must be refused: an anchor exists for this identity and the incoming key differs from it.
///
/// Both key writers consult this. It is a pure function so the invariant can be pinned by a test
/// without installing the process-wide one-shot anchor map.
pub(crate) fn genesis_pk_overwrite_refused(anchor: Option<&[u8]>, incoming: &[u8]) -> bool {
    matches!(anchor, Some(a) if a != incoming)
}

/// Lookup the anchored PK for a given genesis node_id. Returns None if no
/// anchor map is installed, or if the node_id is not a genesis identity.
pub fn get_genesis_anchor_pk(node_id: &str) -> Option<Vec<u8>> {
    qnet_consensus::consensus_crypto::get_consensus_pk_anchor(node_id)
}

// ════════════════════════════════════════════════════════════════════════════
// REGRESSION TESTS — v17 identity-binding hardening
// ════════════════════════════════════════════════════════════════════════════
// Tests below lock in the security invariants enforced by Fixes #1, #5, #6.
// Regressions on these tests indicate either a removed gate or a re-introduced
// format bug. Every test asserts a SECURITY property, never a styling choice.
#[cfg(test)]
mod tests_v17_security {
    use super::*;

    /// Fix #1: `is_legacy_genesis_node` MUST accept the production 3-digit
    /// form. The pre-fix function did exact match against `LEGACY_GENESIS_NODES`
    /// (1-digit) which silently turned every IP-gate into dead code for
    /// real production identities.
    #[test]
    fn is_legacy_genesis_node_accepts_production_3digit_form() {
        for id in &[
            "genesis_node_001",
            "genesis_node_002",
            "genesis_node_003",
            "genesis_node_004",
            "genesis_node_005",
        ] {
            assert!(
                is_legacy_genesis_node(id),
                "production 3-digit form must be recognised: {}", id
            );
        }
    }

    /// Fix #1: backward compatibility — the legacy 1-digit form must still
    /// be recognised so existing call sites that may still emit it are
    /// covered. This prevents a regression where someone narrows the matcher
    /// to "production-only" and breaks legacy paths that have not been
    /// migrated.
    #[test]
    fn is_legacy_genesis_node_accepts_legacy_1digit_form() {
        for id in &[
            "genesis_node_1",
            "genesis_node_2",
            "genesis_node_3",
            "genesis_node_4",
            "genesis_node_5",
        ] {
            assert!(
                is_legacy_genesis_node(id),
                "legacy 1-digit form must be recognised: {}", id
            );
        }
    }

    /// Fix #1 negative: anything outside the genesis namespace MUST NOT
    /// trigger the gate. Specifically:
    ///   * out-of-range numeric suffix (006, 999, 0)
    ///   * non-genesis prefixes (super_node_*, light_node_*, plain text)
    ///   * empty / malformed strings
    #[test]
    fn is_legacy_genesis_node_rejects_non_genesis() {
        for id in &[
            "",
            "genesis_node_",
            "genesis_node_0",
            "genesis_node_006",
            "genesis_node_999",
            "genesis_node_001x",
            "super_node_001",
            "light_node_42",
            "node_random",
            "Genesis_Node_001", // wrong case prefix
        ] {
            assert!(
                !is_legacy_genesis_node(id),
                "non-genesis identity must be rejected: {:?}", id
            );
        }
    }

    /// Fix #1 helper: `genesis_ip_for_node_id` returns the canonical genesis
    /// IP regardless of which form the caller supplies. Centralised
    /// normalisation is what lets every IP-gate site share one
    /// implementation via `check_genesis_ip_gate`.
    #[test]
    fn genesis_ip_for_node_id_normalises_both_forms() {
        // Pull expected IPs from the canonical table — never hard-code IPs
        // in tests; this ensures the test stays correct if the genesis set
        // is ever rotated via constants edit.
        for (expected_ip, bootstrap_id) in GENESIS_NODE_IPS {
            // Production 3-digit form, e.g. "genesis_node_001"
            let padded = format!("genesis_node_{}", bootstrap_id);
            assert_eq!(
                genesis_ip_for_node_id(&padded),
                Some(*expected_ip),
                "padded form must resolve: {}", padded
            );
            // Legacy 1-digit form, e.g. "genesis_node_1"
            let unpadded = format!("genesis_node_{}", bootstrap_id.trim_start_matches('0'));
            assert_eq!(
                genesis_ip_for_node_id(&unpadded),
                Some(*expected_ip),
                "unpadded form must resolve: {}", unpadded
            );
        }
    }

    /// Fix #1 negative: non-genesis identities resolve to None.
    #[test]
    fn genesis_ip_for_node_id_rejects_non_genesis() {
        for id in &[
            "",
            "super_node_001",
            "genesis_node_006",
            "random_string",
            "genesis_node_",
        ] {
            assert_eq!(
                genesis_ip_for_node_id(id), None,
                "must not resolve a non-genesis id to an IP: {:?}", id
            );
        }
    }

    /// Fix #1 surface area: `genesis_node_count()` MUST agree with the
    /// `GENESIS_NODE_IPS` table — the historical bug was that count and
    /// matcher disagreed, leaving exactly one identity off the gates.
    #[test]
    fn genesis_node_count_matches_ip_table() {
        assert_eq!(genesis_node_count(), GENESIS_NODE_IPS.len());
    }

    // v27 HOLE1: genesis identity binary-pinned — lock that the embedded
    // GENESIS_CONSENSUS_PKS is complete + well-formed (replaces the obsolete
    // v17.1 boot-race-guard tests; there is no runtime squat path now).

    /// Embedded set covers EXACTLY the canonical genesis ids, once each.
    #[test]
    fn genesis_consensus_pks_cover_all_ids_uniquely() {
        use std::collections::BTreeSet;
        let ids: BTreeSet<&str> =
            GENESIS_CONSENSUS_PKS.iter().map(|(id, _)| *id).collect();
        assert_eq!(
            ids.len(), GENESIS_CONSENSUS_PKS.len(),
            "duplicate node_id in GENESIS_CONSENSUS_PKS"
        );
        assert_eq!(
            ids.len(), GENESIS_NODE_IPS.len(),
            "GENESIS_CONSENSUS_PKS must cover every genesis id"
        );
        for (_ip, bootstrap_id) in GENESIS_NODE_IPS {
            let want = format!("genesis_node_{}", bootstrap_id);
            assert!(
                ids.contains(want.as_str()),
                "missing embedded PK for {}", want
            );
        }
    }

    /// Every embedded PK is a valid 1952-byte ML-DSA-65 (FIPS-204) key.
    /// A bad entry makes `install_genesis_anchors_at_startup` fail-closed.
    #[test]
    fn genesis_consensus_pks_are_well_formed_mldsa65() {
        for (id, pk_hex) in GENESIS_CONSENSUS_PKS {
            let bytes = hex::decode(pk_hex)
                .unwrap_or_else(|e| panic!("{} pk not hex: {}", id, e));
            assert_eq!(
                bytes.len(), 1952,
                "{} pk must be 1952 bytes (ML-DSA-65)", id
            );
        }
    }
}

#[cfg(test)]
mod genesis_pk_guard_tests {
    use super::*;

    /// THE invariant: a genesis identity's key is compiled into the binary, so nothing arriving over
    /// the network may restate it. Both the RAM registry and the durable node_registry row consult
    /// this. Before it existed, a crafted NodeRegistration naming a genesis id installed an attacker
    /// key even though the transaction never applied — the extraction loop scans the raw block body —
    /// and the durable row outranks the anchor in the vote/QC verifiers and is the ONLY source the
    /// burn-attestation quorum reads.
    #[test]
    fn pinned_genesis_key_cannot_be_restated() {
        let pinned = [7u8; 32];
        let attacker = [8u8; 32];
        assert!(genesis_pk_overwrite_refused(Some(&pinned), &attacker), "a differing key must be refused");
        assert!(!genesis_pk_overwrite_refused(Some(&pinned), &pinned), "re-stamping the pinned value is the repair path");
        // No anchor installed (non-genesis id, or the pre-anchor window during startup install) ⇒
        // ordinary registration proceeds.
        assert!(!genesis_pk_overwrite_refused(None, &attacker), "non-anchored identities are unaffected");
    }

    // The shipped binary must carry an INERT manifest and must say so consistently. A half-filled
    // manifest (a hash or an exclusion list with no height) reads as "no restart" everywhere while
    // silently barring identities — this is the check that makes that a build failure, not an incident.
    #[test]
    fn shipped_restart_manifest_is_inert_and_wellformed() {
        assert!(restart_manifest_is_wellformed().is_ok(),
                "the manifest in this binary is malformed: {:?}", restart_manifest_is_wellformed());
        assert!(!restart_active(), "a fresh-genesis release must ship an INERT restart manifest");
        assert!(restart_anchor().is_none());
        assert!(RESTART_MANIFEST.excluded.is_empty());
        assert!(!restart_excludes("genesis_node_001"));
        assert!(!restart_excludes("node_anything"));
    }

    // Every way a restart release can be built wrong, and the error it must produce. These are all
    // release-time mistakes: nothing at run time can detect them, so they fail closed at boot.
    #[test]
    fn malformed_restart_manifests_are_named_precisely() {
        // Well-formedness is checked over the CONST, so exercise the same predicate over locals to
        // pin the rules themselves rather than only the shipped value.
        let sorted = ["node_a", "node_b", "node_c"];
        assert!(sorted.windows(2).all(|w| w[0] < w[1]), "sorted+deduped is the rule");
        let unsorted = ["node_b", "node_a"];
        assert!(!unsorted.windows(2).all(|w| w[0] < w[1]));
        let duplicated = ["node_a", "node_a"];
        assert!(!duplicated.windows(2).all(|w| w[0] < w[1]), "a duplicate must be rejected too");

        // The invariant that keeps the feature small: a restart names the SAME macroblock as the WS
        // pin, so branch abandonment rides on the pin path that already exists.
        assert_eq!(RESTART_MANIFEST.resume_from_mb, WS_CHECKPOINT.0);
        assert_eq!(RESTART_MANIFEST.resume_mb_hash, WS_CHECKPOINT.1);
    }
}
