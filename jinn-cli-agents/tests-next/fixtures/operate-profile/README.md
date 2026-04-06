# Local .operate-test Copy

This directory mirrors your current `.operate` data for running the next-gen system suites. Populate it with:

```bash
cp -R olas-operate-middleware/.operate/. tests-next/fixtures/operate-profile
```

The `.gitignore` file in this folder keeps the secrets out of version control. Do not commit the copied data.
