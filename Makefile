NAME = silence-cut
VERSION = $(shell grep '"version"' manifest.json | head -1 | sed 's/.*: "//;s/".*//')
ZIP = $(NAME)-$(VERSION).zip

.PHONY: zip clean

zip: clean
	zip -r $(ZIP) \
		manifest.json \
		_locales/ \
		background/ \
		content/ \
		icons/ \
		popup/ \
		-x "*.DS_Store"
	@echo "Created $(ZIP)"

clean:
	rm -f $(NAME)-*.zip
