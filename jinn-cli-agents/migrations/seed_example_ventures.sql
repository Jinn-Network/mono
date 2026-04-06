-- Seed example ventures with rich blueprints for the launchpad
-- Owner: venture safe 0x900Db2954a6c14C011dBeBE474e3397e58AE5421

INSERT INTO ventures (name, slug, description, owner_address, status, creator_type, blueprint) VALUES
(
  'Growth Engine',
  'growth-engine',
  'An autonomous growth machine that acquires users, creates content, and optimizes engagement across channels. Powered by AI agents running 24/7 on the Jinn network.',
  '0x900Db2954a6c14C011dBeBE474e3397e58AE5421',
  'proposed',
  'human',
  '{
    "category": "Growth",
    "problem": "Most projects struggle to maintain consistent growth efforts. Marketing teams are expensive, and campaigns fizzle out. We need always-on growth operations that compound over time.",
    "invariants": [
      {"id": "KPI-001", "type": "FLOOR", "metric": "Weekly active users acquired", "min": 100, "assessment": "Measure unique new visitors per week from analytics dashboard"},
      {"id": "KPI-002", "type": "FLOOR", "metric": "Content pieces published per week", "min": 3, "assessment": "Count blog posts, social threads, and newsletter editions"},
      {"id": "KPI-003", "type": "RANGE", "metric": "Engagement rate across channels", "min": 2, "max": 15, "assessment": "Average likes+comments+shares divided by impressions, measured weekly"}
    ]
  }'::jsonb
),
(
  'DeFi Safety Monitor',
  'defi-safety-monitor',
  'Continuous monitoring of DeFi protocols for security risks, governance changes, and anomalous on-chain activity. Produces daily reports and real-time alerts.',
  '0x900Db2954a6c14C011dBeBE474e3397e58AE5421',
  'proposed',
  'human',
  '{
    "category": "Research",
    "problem": "DeFi protocols change rapidly — contract upgrades, governance proposals, liquidity shifts. Most users learn about risks after exploits happen. Continuous monitoring is needed but prohibitively expensive for individuals.",
    "invariants": [
      {"id": "KPI-001", "type": "FLOOR", "metric": "Protocols actively monitored", "min": 10, "assessment": "Count unique protocol addresses being tracked on-chain"},
      {"id": "KPI-002", "type": "CEILING", "metric": "Report latency in hours", "max": 24, "assessment": "Time between detected anomaly and published report"}
    ]
  }'::jsonb
),
(
  'Open Source Weekly',
  'open-source-weekly',
  'A curated weekly digest of the most impactful open source developments, new releases, and emerging projects. AI agents research, write, and publish autonomously.',
  '0x900Db2954a6c14C011dBeBE474e3397e58AE5421',
  'proposed',
  'human',
  '{
    "category": "Content",
    "problem": "Keeping up with open source is overwhelming. Thousands of repos release updates daily. Developers need a reliable, opinionated weekly summary that surfaces what actually matters.",
    "invariants": [
      {"id": "KPI-001", "type": "FLOOR", "metric": "Newsletter subscribers", "min": 500, "assessment": "Count active email subscribers from mailing list provider"},
      {"id": "KPI-002", "type": "RANGE", "metric": "Word count per edition", "min": 1500, "max": 4000, "assessment": "Measure total word count of each published edition"},
      {"id": "KPI-003", "type": "BOOLEAN", "condition": "Published every Monday before noon UTC", "assessment": "Check publication timestamp from RSS feed or CMS"}
    ]
  }'::jsonb
)
ON CONFLICT (slug) DO NOTHING;
