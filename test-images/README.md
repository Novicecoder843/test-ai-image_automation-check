# Test images

Drop any sample `.jpg` / `.png` / `.webp` images you want to use for manual testing into this folder. They are git-ignored.

A typical setup:

```
test-images/
├── ref-washroom-clean.jpg    # admin uploads this as the reference
├── completion-good.jpg       # similar to reference → expect PASS
├── completion-bad.jpg        # dirty/with trash    → expect FAIL
└── completion-borderline.jpg # somewhere in between → expect MANUAL_REVIEW
```

Then:

```bash
# 1. upload reference
./scripts/test-admin-upload.sh 42 test-images/ref-washroom-clean.jpg

# 2. upload a completion (kicks off the background AI worker)
./scripts/test-janitor-upload.sh 9001 42 test-images/completion-good.jpg

# 3. poll for the result
./scripts/poll-result.sh 9001
```
