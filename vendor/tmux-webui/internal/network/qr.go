package network

import (
	"errors"
	"os"

	qrterminal "github.com/mdp/qrterminal/v3"
	"rsc.io/qr"
)

// PrintQR renders a QR code for url to stdout.
func PrintQR(url string) {
	config := qrterminal.Config{
		Level:     qrterminal.M,
		Writer:    os.Stdout,
		BlackChar: qrterminal.BLACK,
		WhiteChar: qrterminal.WHITE,
		QuietZone: 1,
	}
	qrterminal.GenerateWithConfig(url, config)
}

// RenderPNG encodes text as a QR code PNG. rsc.io/qr is already an indirect
// dependency (qrterminal above imports it for terminal rendering) and its
// Code.PNG() writes a bare-bones PNG directly — no new external dependency,
// no image.Image round-trip.
func RenderPNG(text string) ([]byte, error) {
	if text == "" {
		return nil, errors.New("empty text")
	}
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return nil, err
	}
	return code.PNG(), nil
}
