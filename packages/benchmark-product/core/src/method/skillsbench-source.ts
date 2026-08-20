/**
 * Product-owned identity of the only upstream source authorized for Demo-1 after DR-2026-08-16.
 *
 * Every value below was read from the pinned SkillsBench v1.1 release. The annotated tag object
 * dereferences to `commit`; `tasksTree` is that commit's `tasks/` tree; each task's `treeSha` is a
 * Git tree object, so it authenticates the whole recursive subtree by Git's own Merkle structure.
 * `packageDigest` is an independent second identity: SHA-256 over canonical JSON of the subtree's
 * `{path, mode, sha}` triples sorted by path, with paths relative to the task root.
 *
 * Two identities rather than one, because the upstream surfaces disagree. `registry.json` records
 * per-task `git_commit_id: 55bfe693…` — not the release commit — and carries per-task digests that
 * differ from the release manifest's for the same task. Neither upstream digest is trusted as
 * authoritative; both are cross-checked against bytes recomputed from the release tree, and a
 * disagreement is a source-drift refusal.
 *
 * Changing the upstream release therefore requires an explicit source-manifest code change and
 * review, not caller labels. See `log/decisions/2026-08-16-demo1-skillsbench-source-amendment.md`.
 */
export const SKILLSBENCH_V1_1_SOURCE = {
  authentication: "git-tree-path-blob+sha256@1",
  repositoryUrl: "https://github.com/benchflow-ai/skillsbench.git",
  releaseTag: "v1.1",
  /** Annotated tag object; dereferences to `commit`. */
  tagObject: "a30b2ac88c8f1fd1c77385be6b4dea204ca9eb69",
  commit: "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af",
  tasksTree: "dc144e1357083d9c2cebf3056944fa2c2354770b",
  /** Archived, credential-dependent or integration-incompatible packages. Never admissible. */
  tasksExtraTree: "bafaf3261cb9ac419fc77358fc37a255d6360362",
  rootLicense: { path: "LICENSE", gitBlob: "261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64", spdxId: "Apache-2.0" },
  registryJson: { path: "registry.json", gitBlob: "e0b643d8a3579b5f8a6366411090f59f4f946d20" },
  pyproject: { path: "pyproject.toml", gitBlob: "89cce1304f36b710cb1921f5d32c384f5f20c831" },
  uvLock: { path: "uv.lock", gitBlob: "e1f71ae6afcdf55828592dc061447460734cea00" },
  releaseManifest: {
    asset: "skillsbench-v1.1-task-manifest.json",
    bytes: 73717,
    sha256: "0aa87c4d4f64c33db74b20e770f4b4a77dc21911e81a8ffd50cbb84ac7a4cc6f",
  },
  /**
   * `pyproject.toml` and `registry.json` say `>=0.6.3,<0.7`; README.md and AGENTS.md say
   * `>=0.6.2,<0.7`. The machine-readable value wins, and the range is collapsed to one exact
   * commit — BenchFlow published v0.7.0 through v0.7.3 on 2026-08-16, so a range resolved at
   * install time would not stay inside the supported line.
   */
  benchflow: {
    declaredRange: ">=0.6.3,<0.7",
    documentedRange: ">=0.6.2,<0.7",
    pinnedVersion: "0.6.3",
    pinnedTagObject: "17b301896e05228bb8cfaee7e267ed6dc22c6a89",
    pinnedCommit: "99baefb602674bbd31139fd2f1a22c3ed45752f9",
  },
  activeTaskCount: 87,
  excludedTaskCount: 14,
  /**
   * Blob identity of the Anthropic source-available license. Every one of the 25 per-skill
   * `LICENSE.txt` files in this roster is this exact blob, and it is the same blob Demo-1's
   * superseded manifest already classifies `incompatible` at `skills/docx/LICENSE.txt`.
   */
  sourceAvailableLicenseBlob: "c55ab42224874608473643de0a85736b7fec0730",
  /** Active roster in lexical task-name order, exactly as the release manifest lists it. */
  tasks: [
    { name: "3d-scan-calc", treeSha: "08aaea852094c72995e3e784f5e1c57cd4f6e623", packageDigest: "b47f0663192d5b6b9ea9bcd236f635c223527cbf2c6135e91178f1a1db64e660", files: 9, gitlinks: [], manifestDigest: "sha256:b25e882d1d3a44e4089cd3cea60ebfdfb1b5ac163b2cce0c5ab12a2d439ccf40" },
    { name: "ada-bathroom-plan-repair", treeSha: "ad5ebd1dd57705321b59cb6ac5741aa0f229e071", packageDigest: "4a700a9ad7e1adeb90df4c1a75da9d47c0176892a6964fc82dfde0fc08a4d1e5", files: 17, gitlinks: [], manifestDigest: "sha256:9691aaf3db49f00ab64e9badaaf7e46d4283f36f47b6fc97b4425359264165ca" },
    { name: "adaptive-cruise-control", treeSha: "01c024bafb279e925c743080c0f7200484172886", packageDigest: "d98cfa8bc72907855593826380dd6dbb852b635249f8db8e2716a71a7c7ca7d6", files: 12, gitlinks: [], manifestDigest: "sha256:827d48c1c91dbcac670558b710f0ea6f76f9b5e6c531e4480a48cfe1c77c675c" },
    { name: "azure-bgp-oscillation-route-leak", treeSha: "d1ab813e3515d8766a0be10823b255130a87734b", packageDigest: "4c0e04300fee0786f700878828e85a5223dda859b31d7247109018770fa8c3bf", files: 11, gitlinks: [], manifestDigest: "sha256:58a862b7c0704fbe5ca545f18eeabac39599be94c857e0a7d80781dbbc0a52ef" },
    { name: "bike-rebalance", treeSha: "aa81548ea899d955fe9069dc707f40fafae691b2", packageDigest: "20a481504cfc08cf334327d02611213bc059b07791f2d7bdb04de06e7ad36115", files: 10, gitlinks: [], manifestDigest: "sha256:9366569f77d18bf7630a4ccdbad710c321374350c87e9d69746939432d2e0a7a" },
    { name: "citation-check", treeSha: "c4ec550995c7593788fda27b2e68efc1abbbeb42", packageDigest: "f6d18f85320e6aeda9ea53fa514c80b5d316826eacc791dd0114a1c0d0c1001c", files: 22, gitlinks: [], manifestDigest: "sha256:d78c412f8d9f42b282c12fa009f76b0cda6d9da782ade315946dda747b71f252" },
    { name: "civ6-adjacency-optimizer", treeSha: "1488929bcd963d80fa22bf6c167561ff041907e6", packageDigest: "7f0d7e195a6c95043f02082f85b3bc97296bda7f68cf9a7f5b70e6f6aff4946d", files: 30, gitlinks: [], manifestDigest: "sha256:5e3b398dd390add962fc8e0188734a725477fde38b9ad575f2fed60d91c2bef3" },
    { name: "court-form-filling", treeSha: "ccb11b52daf75d3200bf81633a2bc945fd25dd36", packageDigest: "530022d533440e9a12a46347bab9bc1f7dc1ab60e0c15aa9ca3277d338873345", files: 18, gitlinks: [], manifestDigest: "sha256:2d4d4bd0a5fc64d0103592f3b571e0ec2ee6e9a2489d125b008cc69aef959f8f" },
    { name: "crystallographic-wyckoff-position-analysis", treeSha: "e624c0a2354626b389bbf44c015d1e90ce61517a", packageDigest: "885e57b3e1a1d469793ee24cfa99e1abb45ae4bc9a3bafa76d35c4601dcae1db", files: 32, gitlinks: [], manifestDigest: "sha256:43cbf65a117d248693a81830500e8e9f5271da8c8c5e3374ade82f2c11e74dc9" },
    { name: "dapt-intrusion-detection", treeSha: "23bc23212826dd062baabe90f3f79ce1b8b29613", packageDigest: "ed625b67bee74429c1790785db95ec71f051e6d36fc45d080f6a684d8ca350d3", files: 13, gitlinks: [], manifestDigest: "sha256:1d94af9e3b2e1c6703be4fa53b9f982a86ee45e39a7619bd07d04d6690870d24" },
    { name: "data-to-d3", treeSha: "3ccfb3d26f642516ac3e61eeacc56b338c188ce5", packageDigest: "d24dfc5621e0d65fcc1d44552fe1f90b32f20b8b422c9e2ca76cb56a4abbf02e", files: 61, gitlinks: [], manifestDigest: "sha256:6bd955ce55b21352a441a5706b0e3faaad42b37891145e614b27387f44d38808" },
    { name: "debug-trl-grpo", treeSha: "5f1fe7122caa6148b59c806c4ddcf5bbfa126e41", packageDigest: "96c6898d59511213f0ca513a7aac6503effc414f6d30f196b54d9a3d1e27791d", files: 20, gitlinks: [], manifestDigest: "sha256:6224b1d6251416451c50c5f32436299d251945cd33bd5331c85bac9acb3b4dce" },
    { name: "dialogue-parser", treeSha: "5cf76c4e3d63dac143f10439f169dd23c85c8d28", packageDigest: "c5a0c7a13a2879d202ed393178d5e01cf1f5fc2d4868f85a76407c665bfbaada", files: 11, gitlinks: [], manifestDigest: "sha256:4d48e3b0e7146cb3596bf3f56f9d37cecab57fcbb32058f229e5401182cd191d" },
    { name: "drone-planning-control", treeSha: "6c19f6fee3b97ed894fa2b453bb84fa1c62864de", packageDigest: "5aee8af3f042d0771b25eb6f4059ba1ed7edddd7b10378322d6652854c71ca7d", files: 44, gitlinks: [], manifestDigest: "sha256:a3959e17cf3f2e38e456898d804a105732ea09268feab0f0555216f9f830fcee" },
    { name: "dynamic-object-aware-egomotion", treeSha: "20d7c00b8daf10f2c9fefc6d41fb1dd031aac932", packageDigest: "c467314dbf299a9b2ab4db7bc55b16abed213bc97ade53a376bfcd442950de56", files: 12, gitlinks: [], manifestDigest: "sha256:0028fd6bdc7dc8f792ff6f6e8bef7a901701fc10bb1cfb33054a991eb624c4b7" },
    { name: "earthquake-phase-association", treeSha: "59b157741a488f953a5835c9840809a24dbf849b", packageDigest: "540afbf872dcd45ac9c0404ebe65cdae87da00afe2232d89f9669630f2ac99c0", files: 15, gitlinks: [], manifestDigest: "sha256:a4bd363999e8b59b55bfe545f31aef3d6aec8b770a0fa63aa92a2b032de2210a" },
    { name: "earthquake-plate-calculation", treeSha: "24d0ae47876f78fea83f023151a03a2e4179dde9", packageDigest: "8dc42d77115535b62842b9cefc8d333e7c11e3dc7117a97ec060bcd7a048b1a5", files: 10, gitlinks: [], manifestDigest: "sha256:7174811da91ee6ee6dd52e8c5049307312ef7402e94c655516309c7c9a225cde" },
    { name: "econ-detrending-correlation", treeSha: "80cceb61dc10f160cbbebee270bab84f1d355eae", packageDigest: "bfa78a29756d9511819a4203a7ef2dffa7abcfd8591d14d2b3466dbf058b5f36", files: 10, gitlinks: [], manifestDigest: "sha256:9b238639d4d2c03792ec2bb0ccce3f43b63a91a030a614dadfc755be8ca747b9" },
    { name: "edit-pdf", treeSha: "abd6d17a02c736090c988212a58ea1863011943c", packageDigest: "173ab1cda0324aee877f056ae3734a43c5b96bd0e98ab6c1c0027188eafcc508", files: 9, gitlinks: [], manifestDigest: "sha256:94aeeab12884019d57f010967ae5162288dd1cc29197078517759f7bed45a93c" },
    { name: "energy-ac-optimal-power-flow", treeSha: "85c045e710a77ae461fa5a390cebbe63fb2f18e0", packageDigest: "ac7026276f76ffce1968235cabb2e3d18e8d4ac91717c2585a43d1b253707d20", files: 11, gitlinks: [], manifestDigest: "sha256:6c2795064b385c9aee5137169bd553adeda2df16e21b7f9e41854461b6218b3a" },
    { name: "energy-market-pricing", treeSha: "538484fc14e5e196e90593a3fe6100d196df9af8", packageDigest: "dc1b3c0434d86166f01a067cee0833c1b96d202d857c554fad5d6e677f54b118", files: 12, gitlinks: [], manifestDigest: "sha256:57b3eee7ab0006de70664e6709cb7de5350bf7c64ea18b45ef202fafb4b78363" },
    { name: "energy-unit-commitment", treeSha: "980eb3103ccd70bc0cd3d2158ef8529af1cc29af", packageDigest: "c17df78513c5ddba6260a3cdc1b9895f68d16fd999e9eba1ddf374587760ea50", files: 9, gitlinks: [], manifestDigest: "sha256:cc22e69edc77c65ebda13671a98718c09085e55f3a88087d3cf6ae1cf095b61a" },
    { name: "enterprise-information-search", treeSha: "bd9f746e263b59019a5bdc175fd072b1eebcfb5c", packageDigest: "2975fbac9594b30ece16b9baba0e0fe832bc946c0a10cbbc525864ea4bfcf72e", files: 40, gitlinks: [], manifestDigest: "sha256:57add4050ad2983534267dcc37a8155a29a5e4a305207cfb5b971330f1355d9c" },
    { name: "exam-block-sequencing", treeSha: "c89281469f7f16465d4151d61bb380a09bde02e1", packageDigest: "6f8546e0ee7591b8d8f012b9c0db425b5cf8ff116be73a712d7eb6901e3cc3e8", files: 16, gitlinks: [], manifestDigest: "sha256:653a63535682be320086511f8ccde3671d3eb5f25d75fb36d78298ffc13f90cc" },
    { name: "exceltable-in-ppt", treeSha: "4cf5927fbe22bf7f6c280de0229b2a4e2b15efdc", packageDigest: "2438f09b99192b467d8eb9bcc33eff9e36a4144353e96468b44867698d6d036a", files: 69, gitlinks: [], manifestDigest: "sha256:dae3cb414f9ac36a40caf98a0af19ffc34c99f352645238dd53e0107d1fb66df" },
    { name: "exoplanet-detection-period", treeSha: "a3711388c20a69d8bac2c2fa116a416d94e73647", packageDigest: "ae7683bc5a1b3aa1d88714ca56ee2bfec0eb7718878918bb8108f73469036e00", files: 11, gitlinks: [], manifestDigest: "sha256:67bb300e81cee8649477be83aae60b4e145d41c5547694ee93b9bd6a1d6e33b4" },
    { name: "financial-modeling-qa", treeSha: "107a438257ad8acb0329b01648ecb553f44e4ffd", packageDigest: "c1a30386977c450240050fdafc2e22ce264e9c8bafcfc4a4590459025be0eff3", files: 22, gitlinks: [], manifestDigest: "sha256:c9fd9621f3d14dda5cb73b9d5e30ccdbfcc3c0311d51ab0502ef17065e14770f" },
    { name: "fix-build-agentops", treeSha: "66ccbac03d78ac746d60692a96b9a916dd7800aa", packageDigest: "a87ef0bfb06ba6e8b454d70f5296a40ec933a61cd443d42f5faeb5c67df796f5", files: 14, gitlinks: [], manifestDigest: "sha256:f03d658eee4f3f1e3ac7d91ad41cd63a8145759dc06281482efa7fe671d48edf" },
    { name: "fix-build-google-auto", treeSha: "4c27bb95b137d32039c3d5c0d5c7e47e66b7d882", packageDigest: "69a030668105ce46b7fe5906c98f696b2258ca876c6551cc9e2aa50f570e1365", files: 10, gitlinks: [], manifestDigest: "sha256:a71d138003aa4c28222d6877e0dd65c3ddfbd9f407d5878fd0a235a32e9df8a4" },
    { name: "fix-druid-loophole-cve", treeSha: "5809d0b3a5c27c1190ca0ef6894d7870a1db460e", packageDigest: "09ca827d631dbf86f874224e7c9e83775500d6761ca00ab307b6fb5e7684a6cc", files: 31, gitlinks: [], manifestDigest: "sha256:a53aaa226bfcd53b928ef19364d7bec5da8e49f072c5ea71a323364bf07e3412" },
    { name: "fix-erlang-ssh-cve", treeSha: "d15895ca30d50742a9725c9565236cd3bc36baab", packageDigest: "f94e35287b2797f97fbf8b89ea249ddf2b224fd0dd8bbab9a7fd0abd8ee0432c", files: 22, gitlinks: [], manifestDigest: "sha256:81b3e7cdf8d40c99ecb6321e24759b0a3e78d136ab4fe83a8fec85197586e27c" },
    { name: "fix-visual-stability", treeSha: "10ceb5975854350878e99f95568b6c276687423a", packageDigest: "c0ec350767692c9f949fdd98943897d47c4fb317ec6a48199c14031d545fdad2", files: 84, gitlinks: [], manifestDigest: "sha256:6f4f0977e3f06e6d3fb9b903966e1c1f0b3d1f9b2e3ac60aa7ed27f478a5252d" },
    { name: "flink-query", treeSha: "28d023fbd0f5792a6c7ba039e9ce6c03a6cbbaed", packageDigest: "c62f5003dae0681f621257175222a624e46d7f259b3bcc51b72bd83389d46c0d", files: 40, gitlinks: [], manifestDigest: "sha256:9c47e12a691f2bc0b94941962ee9b7878b2a2f8edf6aec30f02dd602cdc81850" },
    { name: "flood-risk-analysis", treeSha: "40a8e2fef796b9a4771fd3501aad0ff98b33d3fc", packageDigest: "364981491c7baa1de94807b20e9099e60dd6eb4fd21c84bbe72966b935387f53", files: 11, gitlinks: [], manifestDigest: "sha256:2f817566346351ad6fe354c228b720062715527e4089dfcf816f967c9313ae70" },
    { name: "glm-lake-mendota", treeSha: "0d1903f1c260f375114d6b696fd6c6a6b4dcbddd", packageDigest: "ead9a9d6c562fedf5a30377e3085b9c050e98304f96f42fac0044b76e3641ede", files: 15, gitlinks: [], manifestDigest: "sha256:2cffc4a969b971f64b6558de140baaffe663a19dc2e58fc4c6d9c43cafd995ae" },
    { name: "gravitational-wave-detection", treeSha: "eed1fa1cfa7c06a639c3f4bd2aca87f2e214f45a", packageDigest: "17e5dafa6837d650fa01e3fd664b9f444de8bc4d436e06889d60bb26cbe2e2c3", files: 10, gitlinks: [], manifestDigest: "sha256:473c6c69fe42578e2fa476f8a0c2250ce87a6318def1f77b59f4f516972bd56f" },
    { name: "grid-dispatch-operator", treeSha: "a4fc14e927eacb01ad80d0261959a3c79d37c70e", packageDigest: "3c91ca86945af9c95c776d8024a75289ecd024d23f16581bf5eb621d9c13d113", files: 11, gitlinks: [], manifestDigest: "sha256:60c5bca1ec15bdb2053dd672016f8153ce6e64c922f8b0fc0a73228ff24e25b4" },
    { name: "hvac-control", treeSha: "4d2fa90c4427393223728636ba52dfd50ce0e2af", packageDigest: "5eaf8545365cbc90054aaca0b46cc5f989e1da2bf16c034f6cff19fc85e5de4e", files: 14, gitlinks: [], manifestDigest: "sha256:fd4a8c1ffc1b9f5826407486012d96b89a574d4bcb09bdb5075fbe0542ad99e8" },
    { name: "invoice-fraud-detection", treeSha: "7393365928c28f7f1cae2aaa86e96a827c9f33b6", packageDigest: "a3b75857f6792281ed402adf333a55722fdb48c77f3d5103e9d73256d3f86646", files: 25, gitlinks: [], manifestDigest: "sha256:7355f35c7a0bd44ad9f4dd933a357c49d1b4906679ccd7e822e98c8909d237ec" },
    { name: "jax-computing-basics", treeSha: "a12c59632496d6f8922c932c15317375ffc88bda", packageDigest: "7ae2f5df67ea9c8dc035951564ae28c33f0dec1a9adc8a4a3092522220c7bc76", files: 25, gitlinks: [], manifestDigest: "sha256:85f8adc808c68bfacd1fa06b17b91bb82b09aac0848c2ba55e512feb84137b35" },
    { name: "jpg-ocr-stat", treeSha: "4bcfc86ed2223193f06578b0a8c6436a6b940e66", packageDigest: "85c26bf6dd4b7ffd0aba85f5c23ead41d27342721a3e8ab2765115ba594e038e", files: 46, gitlinks: [], manifestDigest: "sha256:7a6137d973f6ddd03ec7fbce9a11f95be9c8ca553efdf681e35d3a186184f968" },
    { name: "lab-unit-harmonization", treeSha: "bed89ef3c7fd3b94e3cb6ed264369b760266b47a", packageDigest: "cb46c8729502ed88712cda85e6d3c3ae46bd9aa8680b4ef8a18a78853a37bd28", files: 9, gitlinks: [], manifestDigest: "sha256:c30aa90c0483f090aa0cba86dd68fdc92f3eb5a2dd0b35eaed2ef94a9134a236" },
    { name: "lake-warming-attribution", treeSha: "8e99105d8ab87d528af37881eacfc8eac1bb171d", packageDigest: "59051597aa705c4b79003358137a9c43543eab48a20657c988a26d516bd83484", files: 13, gitlinks: [], manifestDigest: "sha256:32d3699e6348478971e08322e28b52bd6396d11fa4908f3ad113485730ac956f" },
    { name: "latex-formula-extraction", treeSha: "8240e677aee4a7c892f5ce0f3f1c63fb565c30a0", packageDigest: "acc39ae76ce6cd6ac33b20aead1c1b88d3e915e46b212a3dc0dccf0f04163ea0", files: 20, gitlinks: [], manifestDigest: "sha256:49df78d85f4e04b51db20f17bdfcfb479f19b2e1c8acaf2090a03f8b85c78238" },
    { name: "lean4-proof", treeSha: "812de77e98b37bdbec5bc550d70cd0593a679f18", packageDigest: "25ffe9030e994a4434fd83095c35ebc78c291fceac28ea50704f6f1d3d09149a", files: 64, gitlinks: [], manifestDigest: "sha256:0a37922e73bb30f32f7f345874d5259b2fbc1c4543fa58a5886329e386a2f962" },
    { name: "llm-prefix-cache-replay", treeSha: "6333c87410ab574b20d4acf835f0a27c8b69bcc3", packageDigest: "25a6a3ee27b7b9fd2d664b3127093b084e8b8e6e3e2a9eca378601af0c36fae7", files: 10, gitlinks: [], manifestDigest: "sha256:ac5d31f79c6fb25306e9e7216ccf56407f637a12097f31930ed494c0cada5deb" },
    { name: "manufacturing-codebook-normalization", treeSha: "dfc7b93fb11ad7adf3e13ea43e95e48c35c1c34a", packageDigest: "de2c7a8be8e5955d8e6620237a0264a28cfde6ceb27280d469d7947d19d5ada2", files: 11, gitlinks: [], manifestDigest: "sha256:07f8f87ed53b8224fefc65dc220537572980e0794970db30e3873aebd063c9d3" },
    { name: "manufacturing-equipment-maintenance", treeSha: "b89763b1d33a702552769172f857979790b4ab1b", packageDigest: "f5c586cb7caa3e5bec756c434de45a1480470902100590588e6798d24fec2562", files: 12, gitlinks: [], manifestDigest: "sha256:477f88b04a7a8c6a2de0d05a1bc4f3e0336a9170ea745dfca4b4b2ff33f5fdfd" },
    { name: "manufacturing-fjsp-optimization", treeSha: "c4cd8a734884b6b5b167397e1f1743262d43cc55", packageDigest: "fc740acbc4962d3c3263396c3cacac05a4b2c9e6af0bd9bfaa27ece234e445c7", files: 12, gitlinks: [], manifestDigest: "sha256:7b1e01c2d74c6333e629c63c09d963eff9f846b5ac96318d13cc0cde95a3d444" },
    { name: "mario-coin-counting", treeSha: "2ab7b4062c5631bf46783bedb33379bb270857d2", packageDigest: "63b20bea0058cd86ee54b60caa26ddee306ef8a4df9403b75c3d57c3d269cb48", files: 14, gitlinks: [], manifestDigest: "sha256:e66bd69fb226e0ae23563f535b952ea66d6f49e2bf0e315f7d95acf035acce2f" },
    { name: "mars-clouds-clustering", treeSha: "16c804b5d224b62403add5bcdddf9f5e494528ab", packageDigest: "82306802bca4713f83d0ed7df25460741d0fa16f3e5489e630d8e99197cff1a3", files: 12, gitlinks: [], manifestDigest: "sha256:df164f340bb3df4ef99997a5fca44fec0c36f4f11c34762a9a1da87cac05dc68" },
    { name: "multilingual-video-dubbing", treeSha: "2b5ff138163b8c137c6e0e3a2000e05ff69fa744", packageDigest: "976340720d3788f2632ce2e4d9bd6f549dfbe44af3261bba145225c6b4eeffa3", files: 16, gitlinks: [], manifestDigest: "sha256:8947bde71c1cb7d9652daf827bd979e9f09d14b5e89941871d4cdc895646d81a" },
    { name: "offer-letter-generator", treeSha: "e6ca02fc01390992e768d9040a1c08cb5f22789a", packageDigest: "34f04f7f0954beba202d0c7f80bc999341b3b375005f92978d357cd08fbc1406", files: 8, gitlinks: [], manifestDigest: "sha256:c9b406ec4509a0742d54add417d145913d1f0273e01b1735c4607f777b7cffbc" },
    { name: "organize-messy-files", treeSha: "640993732fe0d1d81842e2aa89cc9448a939f7e1", packageDigest: "41eb2b7f359d501c54c6038468100fca33a3b6e26f740343a5c4992bde7e3bc7", files: 146, gitlinks: [], manifestDigest: "sha256:09f43f6b7454bd68b186948550155a1b26310d8e047cd43834af46795e7fcf43" },
    { name: "paper-anonymizer", treeSha: "9ec7e40419da7c8dd192463c95efce740c0c6737", packageDigest: "04835685ddfae9557da91f02f8d24a4dea9085f3870431136a8e9cef75dc6ef5", files: 13, gitlinks: [], manifestDigest: "sha256:be99a90a20f308e3e5349bed9800a087b4bdf62517e37d54c67e934e55176357" },
    { name: "parallel-tfidf-search", treeSha: "75a5097b5f02c9a8229be38267cb03e11a935b74", packageDigest: "12656e2995c5b3f2ed82048e3dceaa5ca53455a9d2e36c670f4aca398ce6a221", files: 13, gitlinks: [], manifestDigest: "sha256:482f37d1b1cb39de2c6dcfe36ad1db5b5594ebf0ca76abb9c504d061a27e3b02" },
    { name: "paratransit-routing", treeSha: "99998e9a656f3af413d8941a8cc58567e66047a5", packageDigest: "9506a54bbd1a5531922c37ad3de025b630c488e42c39ef63817cca78f797ff3f", files: 13, gitlinks: [], manifestDigest: "sha256:839b0c7b035503e9b70f8901b69f47e70f7f790b961cabfeb8e8ccc417a27500" },
    { name: "pddl-airport-planning", treeSha: "24357e0a474750ade194377999b4445ca8187792", packageDigest: "a8f64600a0c91cd53c7772b1d7f4c4341ecb1e7c19ffd1f13605f39563ad29b0", files: 73, gitlinks: [], manifestDigest: "sha256:d4994f5b27d70de16342f7f3d2a9a2d2ad8d3701edefd2fc23ce36ff82f37d3e" },
    { name: "pddl-tpp-planning", treeSha: "0e8be395c33ebefa6f7be666ab235bd9c5d70812", packageDigest: "7e7487a8978d91fb9f09be08f53e2cd284b11c24e5ea21d1e9c1418787c454c5", files: 44, gitlinks: [], manifestDigest: "sha256:536ad41c86db02eea73da1483768f55f68cd53fc91b74c38cffb38ea4f2445f0" },
    { name: "pdf-excel-diff", treeSha: "79d4c8473fc520862b094dc1a8c8450d4c27af27", packageDigest: "5de9dff0dd83bcc3ea03dc5cf6123ca54b1e0edf551fb4add92f1dad32df619e", files: 21, gitlinks: [], manifestDigest: "sha256:555a80997825f9258d023aeb53df148d54a41a93833d970bcd6ff417adb63667" },
    { name: "powerlifting-coef-calc", treeSha: "18ba9a999605243ff8d3a7fcee84ba5a3454c3b0", packageDigest: "73fa0df9e7f59fb568c4544a38ab900e2a22ee5fa1e051492225c8ce9deea4d7", files: 19, gitlinks: [], manifestDigest: "sha256:23be68ce08baceae83a988ac9e3803ea65d8d2f2d7c3dfdb84fd6a4ceff278d1" },
    { name: "pptx-reference-formatting", treeSha: "ed1a9f096cf1c7114e140ae4d6b4adb0aee966a1", packageDigest: "cf5dd15a98e1e5e4f67abeabdd8cf1d2449e92ee1ab5cdd17ce18cb185a51199", files: 62, gitlinks: [], manifestDigest: "sha256:25c81ae61ac4623ab9acaa3c5dbb68969973cc959c29ea4fd15db1c24d4fceb4" },
    { name: "protein-expression-analysis", treeSha: "aeb615484aeb542fea3669ebe734b65c9181c7a1", packageDigest: "00d9a8577432e99cd4d4fd7de0dc8d337e2346e9be1852d96fa115bb1e63fc26", files: 9, gitlinks: [], manifestDigest: "sha256:dd81d820bc8dfd9a6cb8a48e7eafa72a7bf430b65a3bb4948a359573174df196" },
    { name: "python-scala-translation", treeSha: "d65117211b4c98c69bbee1ac340a730c3935d013", packageDigest: "9aa4ba49603a68e2b57949f825ffaf4b6fbf81408ae2e3ce6c4c8486296c2e35", files: 23, gitlinks: [], manifestDigest: "sha256:d84a2aae85cce5480402fed5095a06495efa07a4ca458505171515d7707fc013" },
    { name: "quantum-numerical-simulation", treeSha: "c1a842d4bc9f7784f2224cab04fbfda7b66c3d94", packageDigest: "7b9834ccdbc95dc098b2d0794ca2c7cde5a31f29412f69432993bd048f9e7891", files: 12, gitlinks: [], manifestDigest: "sha256:434e1ac9ffe67525341b8f90d16657dcdaa3a21cf4e56466ef15e754df10e659" },
    { name: "r2r-mpc-control", treeSha: "b4b6f558601cd24a9f83af0dfec0d23915e12eb8", packageDigest: "b071037282a2ab9e14083e07bd86742d2e6ea2523754627b77bb53043e2f6d03", files: 11, gitlinks: [], manifestDigest: "sha256:1b0b77e7fccaa8a88e763cb5fd39e32f1d439dceef3b971f18beee224a7ffeac" },
    { name: "radar-vital-signs", treeSha: "cc8ecd5cb0d686fb00dd0d403e64e893801bd29a", packageDigest: "e5d9933e7531ee618dee402faf8e156e40653439b0460604d55e7793f884e4df", files: 52, gitlinks: [], manifestDigest: "sha256:a0cd2e92dfb6933cff15749879de04566c496051f7560bf05a998b6b93ed1b18" },
    { name: "react-performance-debugging", treeSha: "84726849438a00e2bb98dd8eea8058a4036da486", packageDigest: "e6c057759138f192212255389cb32d652b6c5a31d62a93beddae7878fd5af362", files: 81, gitlinks: [], manifestDigest: "sha256:598d880dbacaa43e05cd93786ab88d424690c47fd2636b41f2e6602fb385d4d8" },
    { name: "reserves-at-risk-calc", treeSha: "10b0bf3485041a430219fb58b0a8f28f80b7f430", packageDigest: "0b175684cd737a938c418dbfa0c8a4dfcb14e898940dd75c469cb7bb3d85747c", files: 10, gitlinks: [], manifestDigest: "sha256:bbf57b1a76688f2877c29db1bbcfed818acd9cda238a25d76fedd6bdbbadbd55" },
    { name: "sales-pivot-analysis", treeSha: "448ccd66daa9026fe6c7fa15b42338d4f49e79a3", packageDigest: "9c35d8590acb6b5fe587b4db7b6ab8ef9ccbd8b3e9aca0ca8f1abe263304ba6f", files: 9, gitlinks: [], manifestDigest: "sha256:d904b56d07ee53b5d6f2784409d877143b9137b14b7a0c6885895c28cb0be764" },
    { name: "sec-financial-report", treeSha: "1d137a9467eb8058684d64f4ec5fc5f230ca99df", packageDigest: "cc0e35920dcab34eca12a97bcd6aac6c6bdba38a4e5097d295e0ee4f2cb31d83", files: 14, gitlinks: [], manifestDigest: "sha256:2274c6f554782e3061a3ff7d076362501617dd744d1286c7889188a003d62b2d" },
    { name: "seismic-phase-picking", treeSha: "bf41ff55010177aef8e56f2259545df2d2682518", packageDigest: "17f902119e02bb150d62438680fd3d0ebe741f89142a929c2fcd72cda171dcd6", files: 114, gitlinks: [], manifestDigest: "sha256:7f906f01a7f5217ca67ccb15fd53725375b97bd774c8980fe96f7ce6fc7c3118" },
    { name: "setup-fuzzing-py", treeSha: "c32bc22da99ab2b3b7a437c2eca405c9cf243069", packageDigest: "f600323ff6dac6cbd0627749d02e1e01fa53303024cc92cab39e0625ab991b6d", files: 11, gitlinks: [], manifestDigest: "sha256:ac70897b525ee19474225247a9132f4beaa9365ad8a4af064305321997147c0d" },
    { name: "shock-analysis-demand", treeSha: "ad34b5f420e05c883843e846a563ebe7f15b25f8", packageDigest: "3662ffe25fcefbbbd9bdb14651766e95c9dfd776a64c93fc1b8752e873fc53e7", files: 10, gitlinks: [], manifestDigest: "sha256:6d1ee94a0c9ce1bec020b115022208f889111d70cb8eb2acd4521c2368a176dd" },
    { name: "shock-analysis-supply", treeSha: "5deb6883e49411c672b7d8b136d2440450304f86", packageDigest: "a22ffb3b9eb346caa4e1772ca05f39083ecc00bb061f6536c495342460f06e06", files: 10, gitlinks: [], manifestDigest: "sha256:b3ef079863d7cadf258e7f388229248e3bf42e06e5d6b0196656b0d186dec8f5" },
    { name: "simpo-code-reproduction", treeSha: "37f77b35f66846157a0bb9a714e9bc116db8c9ae", packageDigest: "37fbc3a41b2e09fd17557157a5e4d04a2e449fbfd2e82c515edfcfe311ed7594", files: 82, gitlinks: ["simpo-code-reproduction/environment/SimPO/alignment-handbook"], manifestDigest: "sha256:a436e280e9d3aabba9486530d1c10fc1ebcfa4f883bc4b9765259300767568af" },
    { name: "software-dependency-audit", treeSha: "3dad5d37ea594461a628eae04206e2a59ff1abc5", packageDigest: "d66e71c108c154a2adb76f449bfa54fd62f930054a9f5482ee344903299f60bd", files: 11, gitlinks: [], manifestDigest: "sha256:806b47bea8b86a370c18dee279f6322da3a9b23026287876c2e9ffbfac855ec3" },
    { name: "spring-boot-jakarta-migration", treeSha: "cb41158e7ddb4aa1849a901835ef34bd678c0ed5", packageDigest: "a1e1344d65f4a89f42d14647f2a72253c93bc25217cdb976b840fd1a9bbfc7b8", files: 27, gitlinks: [], manifestDigest: "sha256:2f5a32911b6e7bba86a6eb94e012e088f536d13ea823e7d0760b6ea93de51fba" },
    { name: "suricata-custom-exfil", treeSha: "22e8b26e818ea5437b4b9c0c72c330bcd691ce90", packageDigest: "cb289aeeb18cabca4300035693e94b98ba5a430012345e03a638d79f5cc90b65", files: 13, gitlinks: [], manifestDigest: "sha256:1a282d9d2283b8def6105a1e9e2ac1eb8eb30eeba79b452f6276d77a2197c986" },
    { name: "syzkaller-ppdev-syzlang", treeSha: "03ac225ffb898309d91d0062bd7912702ba54d71", packageDigest: "be390b397e745ac2060d3203e17374cab76625c815e83981ea6feb6320682f44", files: 8, gitlinks: [], manifestDigest: "sha256:428a0a71086a6e1f537e0da43a65fa64d2c7e5545777cddbac611de90ad1b133" },
    { name: "threejs-structure-parser", treeSha: "f0fae390d5092512c4dd8f9eed60d62bae6b7a1f", packageDigest: "3b68203286b779b197e9ef56903b77f39400367ff8217c3d3466f774241122d7", files: 15, gitlinks: [], manifestDigest: "sha256:adb134c373db87374ed4231a4c7bb0efe4bd012737e6ef2989e7a71fed677aad" },
    { name: "threejs-to-obj", treeSha: "ff80ee07e2fb5da9714f71df40e7db1e7eefdeb9", packageDigest: "44a73e2d4c850ab624a075258857db11fa4c29e7316a0ecb4527abc5c591b756", files: 15, gitlinks: [], manifestDigest: "sha256:a6685ad8902228229c50d82684f0600fbc9a387f96e19378b4bfc8de150ff268" },
    { name: "tictoc-unnecessary-abort-detection", treeSha: "2cf6cdd8613365ca3327c20005be45736ba9e7d4", packageDigest: "dd6dee2732599ebb0af310d27547930e8a91f983be8ef74ac382325d044b8714", files: 31, gitlinks: [], manifestDigest: "sha256:2142ae37cde1142f7ffbe4be59107d94171221d28ed6d390c4ec736bf26d2906" },
    { name: "travel-planning", treeSha: "c3c1badd81b9b8b8a16ebfec997e60e8ae579907", packageDigest: "d5e18a324fbb3f62f98fda1091153a7e20c068dce31519fb15bfc33e77547906", files: 28, gitlinks: [], manifestDigest: "sha256:99dd2da5c704914c52b220c9d26366e0ebf04e15ce24ac07635c9dc2c58d48bd" },
    { name: "video-silence-remover", treeSha: "720224108c935efd8e29e2833d827f9c70d90164", packageDigest: "492f253709f766a3a0faf84450b6c02427a876057aa259a23fa8ba032f65c0bf", files: 22, gitlinks: [], manifestDigest: "sha256:66efcc64a2f38eaf183af213cff15b3dcb2119a33e20bde86024b5bf7a4b71bb" },
    { name: "weighted-gdp-calc", treeSha: "356bd34838098c49295f0d0fec7201a58786f6f2", packageDigest: "a51032c1b8ef7a49669a9b014d033b1ed53b5e88a0aaabc86866f3b554f3267e", files: 9, gitlinks: [], manifestDigest: "sha256:3a0f4971eb3f2407df8a60a156d847f0290c9dd1709a596aa5b9d13713f57d2f" },
    { name: "xlsx-recover-data", treeSha: "ee406fa6b25a9086638bfb65197e273bed1df0df", packageDigest: "1b02071d7353f8cb0786cd58550a9ca202d4da20f9d8650682616c5910571eab", files: 14, gitlinks: [], manifestDigest: "sha256:5461eb5dec0c941670dd59e103a1cdbe826da6824c66de0334f65c031690299d" },
  ],
} as const;

export type SkillsBenchPinnedTask = typeof SKILLSBENCH_V1_1_SOURCE.tasks[number];
