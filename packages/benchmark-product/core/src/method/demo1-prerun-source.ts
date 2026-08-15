/**
 * Product-owned identity of the only upstream source authorized for Demo-1.
 *
 * Every path/blob pair below was read from the pinned Git tree. The SHA-256 and byte count
 * authenticate the fetched file bytes; the description digest authenticates the exact metadata
 * later carried in the independently recomputable freeze artifact. Changing the upstream commit
 * therefore requires an explicit source-manifest code change and review, not caller labels.
 */
export const DEMO1_PINNED_SKILLS_SOURCE = {
  authentication: "git-tree-path-blob+sha256@1",
  repositoryUrl: "https://github.com/anthropics/skills.git",
  commit: "f17010c9bb483898c1d9c9f42dde2b3a98889434",
  commitTree: "0fe4c0c8372b239b13062036d08d05f79d4055a1",
  skillsTree: "491339fffffe73a52f638f09747dddd8ae2cf154",
  candidates: [
    {
      repositoryPath: "skills/algorithmic-art",
      folderTree: "4aef6bcad51d058ec32b1acb9da436851863e56e",
      skill: { path: "skills/algorithmic-art/SKILL.md", gitBlob: "634f6fa42e4e697fa6afd293acd7fb8246574876", sha256: "3bc4092c09804853186524c826bc0621b940bb6122c05b84496dff95388e6eef", bytes: 19769, name: "algorithmic-art", descriptionSha256: "b85e0231980497832c9e7350aa3a5ab879e1f4e0ce6479a9cc2bec8ff677774e" },
      license: { path: "skills/algorithmic-art/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/brand-guidelines",
      folderTree: "1dc8bd3584b80568edae7da16382363e24ecf0f0",
      skill: { path: "skills/brand-guidelines/SKILL.md", gitBlob: "47c72c607bdb5dd81bdea5de2b5e4f3992a5fd59", sha256: "1120b3769e2985cefb3d25be981b1f914abeba57ae079b83c20c666c164fa9fe", bytes: 2235, name: "brand-guidelines", descriptionSha256: "5678c04b110828cccabb6cf9f082685efef7437133d75463e2a8bb3c03e51f67" },
      license: { path: "skills/brand-guidelines/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/canvas-design",
      folderTree: "95095faaee2ea943e85a5d1d562fde06841e835e",
      skill: { path: "skills/canvas-design/SKILL.md", gitBlob: "9f63fee82de84cd4230e1d0e322247b61eb4c94c", sha256: "a1f288079624402f30682753c1d43920b6664785698d21d3e7aa197450a6448b", bytes: 11939, name: "canvas-design", descriptionSha256: "e837915070567de724d3068897efa7d522db4f08f9fb6d4f423225979523ca56" },
      license: { path: "skills/canvas-design/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/claude-api",
      folderTree: "f5a11c25cbe8b46d0260e9c14f8257a6e1fe5dec",
      skill: { path: "skills/claude-api/SKILL.md", gitBlob: "7f61519cc82eb2a99d4a3dc41a1a24fa08583ce0", sha256: "57c1e405c5110a14aeff2da10d25b95c188d801fc9a779fa7d7a25ccbf46b890", bytes: 72716, name: "claude-api", descriptionSha256: "76f94a0a666549bd4e41b279079c50412372b80f8591bc94e0b05ed9d5ec801f" },
      license: { path: "skills/claude-api/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/doc-coauthoring",
      folderTree: "d9df960e61fe2bafe9183e37de6f9f6b73b74087",
      skill: { path: "skills/doc-coauthoring/SKILL.md", gitBlob: "a5a69839ef4a161131d80b6daef10037a9686f4a", sha256: "2e47d78846faeea4a56e9809c52700087a15a2155a3f293a3efbaded81398ef4", bytes: 15815, name: "doc-coauthoring", descriptionSha256: "1a1433d4314dd9072bb9f2a4cc234148382e6364fef972c9b32c88aed21bea35" },
      license: null,
    },
    {
      repositoryPath: "skills/docx",
      folderTree: "6e6f5b95c1de6e803cc07b214f5059b074d64e0c",
      skill: { path: "skills/docx/SKILL.md", gitBlob: "fb954a460a1ea2294e9595e87fecce8df043eeba", sha256: "8017469ea95fb7d28225c62daf8e2f3492a7b516fc64c18c28977cbf8980b7fe", bytes: 6911, name: "docx", descriptionSha256: "622e60ca3c82adf6866787ba2d255299582e9eac6a5dd450062dbf69be6f46b3" },
      license: { path: "skills/docx/LICENSE.txt", gitBlob: "c55ab42224874608473643de0a85736b7fec0730", sha256: "79f6d8f5b427252fa3b1c11ecdbdb6bf610b944f7530b4de78f770f38741cfaa", bytes: 1467, status: "incompatible", spdxId: "LicenseRef-Anthropic-Source-Available" },
    },
    {
      repositoryPath: "skills/frontend-design",
      folderTree: "0d5b74a14bdf3ebcd64f352d06376a2ef05ed296",
      skill: { path: "skills/frontend-design/SKILL.md", gitBlob: "decdff43d05908b4c1fc2cfd2d80fc5743440934", sha256: "1608ea77fbb6fc30d13a97d12cfa8ebf31358d40f0dd97beed24829d6b3f45dd", bytes: 8260, name: "frontend-design", descriptionSha256: "f6aca329665c9761de344b5e6dad22a0318b84a356c6f059d641dcb973bb62ec" },
      license: { path: "skills/frontend-design/LICENSE.txt", gitBlob: "f433b1a53f5b830a205fd2df78e2b34974656c7b", sha256: "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594", bytes: 10174, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/internal-comms",
      folderTree: "9869687dcf6deb6802ca88ac11e67b6f7278017a",
      skill: { path: "skills/internal-comms/SKILL.md", gitBlob: "56ea935b74f371bfeb4c7d3c19d5139df866e73b", sha256: "067b7587a344a928fc6534ef66b1bcd591fc7c26d207ea7ca3334aeb678d6475", bytes: 1511, name: "internal-comms", descriptionSha256: "3e5a92014a9adb40b967fbc85b8f0d7f52c6799803030e046ef171e804070aa9" },
      license: { path: "skills/internal-comms/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/mcp-builder",
      folderTree: "b866bcfb57b780c10b587c7b543e871a91661ce0",
      skill: { path: "skills/mcp-builder/SKILL.md", gitBlob: "8a1a77a47d141967b246adb4da4f91037578ff7d", sha256: "0f4592dcb53cf2b5d6b7febee6b4152018b565551a1c29e3c612f57b218ab295", bytes: 9092, name: "mcp-builder", descriptionSha256: "dd9ba25d52050d05dbb6a41c828679972d696de348b966e2935e718d3d1bae86" },
      license: { path: "skills/mcp-builder/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/pdf",
      folderTree: "6369f4649de69bd6857c9bc3b058a77206009238",
      skill: { path: "skills/pdf/SKILL.md", gitBlob: "d3e046a5ae107a6cb23cfb16c219837094ab35d3", sha256: "9f78b8359fbd4943ad260a7a1e436e5a96503406d6c34e99f69223d647d85b9c", bytes: 8072, name: "pdf", descriptionSha256: "d1906e2fc005cb80c70b054ca9a61cbcaa67f14c348463f18c7c3bd41e682d02" },
      license: { path: "skills/pdf/LICENSE.txt", gitBlob: "c55ab42224874608473643de0a85736b7fec0730", sha256: "79f6d8f5b427252fa3b1c11ecdbdb6bf610b944f7530b4de78f770f38741cfaa", bytes: 1467, status: "incompatible", spdxId: "LicenseRef-Anthropic-Source-Available" },
    },
    {
      repositoryPath: "skills/pptx",
      folderTree: "64529c8b3f35fe632b7256bd2f6d46e4b40160ce",
      skill: { path: "skills/pptx/SKILL.md", gitBlob: "41cd2306977f269bb1d8169a9643b35053aa66bd", sha256: "a7ff03e2c85b636f55232a6b1555f5dd90216b7a1a359ab289d8364e6acbc6a0", bytes: 20796, name: "pptx", descriptionSha256: "0197a5fe5ea196e480d3fc7838335f8527bcf05ac4cb59d5211f88226c99b850" },
      license: { path: "skills/pptx/LICENSE.txt", gitBlob: "c55ab42224874608473643de0a85736b7fec0730", sha256: "79f6d8f5b427252fa3b1c11ecdbdb6bf610b944f7530b4de78f770f38741cfaa", bytes: 1467, status: "incompatible", spdxId: "LicenseRef-Anthropic-Source-Available" },
    },
    {
      repositoryPath: "skills/skill-creator",
      folderTree: "3cf9a8db32597ba3e24b584a3d696f4e11c7d7b6",
      skill: { path: "skills/skill-creator/SKILL.md", gitBlob: "65b3a402dbd09b8e83f9d637c6b553875189085c", sha256: "dcd4803e61e913e6fc27294184cd3a71f09f5e924ff20c8a9a20173e7b3c2bcf", bytes: 33168, name: "skill-creator", descriptionSha256: "dc3522ad3e3e46453a411f9d4f55faa15828e312933e722c1be9e8e3a7712cab" },
      license: { path: "skills/skill-creator/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/slack-gif-creator",
      folderTree: "c61d2f7bb6334b68a6936ad3f41ebfc7cb76fe2a",
      skill: { path: "skills/slack-gif-creator/SKILL.md", gitBlob: "16660d8ceb77af47986bba1c9176c2ff3f287a91", sha256: "2efca615ce55a3edd8fc05c779068a8085816617991987e446606403cd3abb22", bytes: 7841, name: "slack-gif-creator", descriptionSha256: "01945558d30fc1ca27e8dccb7fbc854a47ee5c9131e38ba7a3244739c4e6ab41" },
      license: { path: "skills/slack-gif-creator/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/theme-factory",
      folderTree: "e05534d132fb1b21f9917840874758e30f0a9b1a",
      skill: { path: "skills/theme-factory/SKILL.md", gitBlob: "90dfceaf2ecdc191a4dcfb0069768a9560638998", sha256: "c35893e221e28895c52143cc11bf30e41a44817796b39d4b15727dadc9796552", bytes: 3124, name: "theme-factory", descriptionSha256: "35f48ac45701d5cd5a23014409c5a711ab86dc4509d2b8ea1a30edf2c652185d" },
      license: { path: "skills/theme-factory/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/web-artifacts-builder",
      folderTree: "821b94f16c123d5f12e4e72eda9f7a162e2698f6",
      skill: { path: "skills/web-artifacts-builder/SKILL.md", gitBlob: "8b39b19f259b4216ecb07574741dd8eaa9863a07", sha256: "81c5002c6643b0de7b8710b00e7a9038daa6fb9b68d59870ee6adb12da8d10f8", bytes: 3087, name: "web-artifacts-builder", descriptionSha256: "ba76113a90155d78ff21e7812e69e54c271a7441949897d499d3ae48f1cbb99a" },
      license: { path: "skills/web-artifacts-builder/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/webapp-testing",
      folderTree: "5ffb7dc66b9fd4c25c3e400a4c00da99a349b714",
      skill: { path: "skills/webapp-testing/SKILL.md", gitBlob: "4726215301db64a0cc4d41fc3219c61f37a30f4a", sha256: "51b7349e77ec63b7744a6f63647e7566a0b4d2e301121cc10e8c2113af6556a2", bytes: 3913, name: "webapp-testing", descriptionSha256: "05bd234ecb67739592cef6b1f23923e97dc7d527351dc64c0d98bcf2687d99cc" },
      license: { path: "skills/webapp-testing/LICENSE.txt", gitBlob: "4f881c52d1f72f4cfb720e339e2d35c3058d01a9", sha256: "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362", bytes: 11345, status: "compatible", spdxId: "Apache-2.0" },
    },
    {
      repositoryPath: "skills/xlsx",
      folderTree: "fe6471cc9b5b97aae0b576ccb92ffd9b0207589d",
      skill: { path: "skills/xlsx/SKILL.md", gitBlob: "9da54804cc8c938586f89363c8da3b3a6e2a563d", sha256: "6712b39718fe815054abca9c3ee72f989613e6f771c8a5c58f30a65a6c905622", bytes: 8598, name: "xlsx", descriptionSha256: "efd008c86ccd7afe9019af48f04fcd5192414bef7f1f5c44d8454348db04ed2f" },
      license: { path: "skills/xlsx/LICENSE.txt", gitBlob: "c55ab42224874608473643de0a85736b7fec0730", sha256: "79f6d8f5b427252fa3b1c11ecdbdb6bf610b944f7530b4de78f770f38741cfaa", bytes: 1467, status: "incompatible", spdxId: "LicenseRef-Anthropic-Source-Available" },
    },
  ],
} as const;

export type Demo1PinnedCandidateSource = typeof DEMO1_PINNED_SKILLS_SOURCE.candidates[number];
