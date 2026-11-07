package buildinfo

// Injected via -ldflags at build time. See .goreleaser.yaml.
var (
	Version   = "dev"
	GitHash   = "unknown"
	BuildDate = "unknown"
)

func String() string {
	return "tmux-webui " + Version + " (" + GitHash + ", " + BuildDate + ")"
}
