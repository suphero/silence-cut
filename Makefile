NAME = silence-cut
VERSION = $(shell grep '"version"' manifest.json | head -1 | sed 's/.*: "//;s/".*//')
ZIP = $(NAME)-$(VERSION).zip

.PHONY: build watch typecheck zip clean

build:
	npm run build

watch:
	npm run watch

typecheck:
	npm run typecheck

zip: clean build
	zip -r $(ZIP) \
		manifest.json \
		_locales/ \
		dist/ \
		content/panel.html \
		content/panel.css \
		icons/ \
		-x "*.DS_Store"
	@echo "Created $(ZIP)"

clean:
	rm -f $(NAME)-*.zip
