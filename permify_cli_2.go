/*
 * Permify/permify-cli #2 — Credential storage for CLI tool (Go)
 *
 * Stores endpoint, token, cert path, cert key in ~/.permify/config.json
 * with secure file permissions (0600).
 */

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Credentials holds the stored CLI configuration.
type Credentials struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token,omitempty"`
	CertPath string `json:"cert_path,omitempty"`
	CertKey  string `json:"cert_key,omitempty"`
	Insecure bool   `json:"insecure,omitempty"` // skip TLS verification
}

// configPath returns the path to the credentials file.
func configPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot find home directory: %w", err)
	}
	dir := filepath.Join(home, ".permify")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("cannot create config directory: %w", err)
	}
	return filepath.Join(dir, "config.json"), nil
}

// SaveCredentials writes credentials to ~/.permify/config.json.
func SaveCredentials(creds *Credentials) error {
	path, err := configPath()
	if err != nil {
		return err
	}

	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return fmt.Errorf("cannot marshal credentials: %w", err)
	}

	// Write with restricted permissions (owner read/write only)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("cannot write credentials: %w", err)
	}

	fmt.Printf("Credentials saved to %s\n", path)
	return nil
}

// LoadCredentials reads credentials from ~/.permify/config.json.
// Returns nil, nil if the file doesn't exist (first run).
func LoadCredentials() (*Credentials, error) {
	path, err := configPath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // no credentials yet
		}
		return nil, fmt.Errorf("cannot read credentials: %w", err)
	}

	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, fmt.Errorf("cannot parse credentials: %w", err)
	}

	// Mask empty values — JSON stores "" as empty string, not null
	if creds.Endpoint == "" {
		return nil, fmt.Errorf("endpoint not configured. Run 'permify configure'")
	}

	return &creds, nil
}

// ── client.go: use stored credentials ──────────────────────────────────────

package client

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"

	permify "github.com/Permify/permify-go"
	"github.com/Permify/permify-cli/internal/cmd"
)

// New creates a new Permify gRPC client using stored credentials.
// If endpoint is empty, loads from config file.
func New(endpoint string) (*permify.Client, error) {
	var creds *cmd.Credentials

	if endpoint != "" {
		// Use provided endpoint, load rest from config
		var err error
		creds, err = cmd.LoadCredentials()
		if err != nil {
			return nil, fmt.Errorf("loading credentials: %w", err)
		}
		if creds == nil {
			creds = &cmd.Credentials{Endpoint: endpoint}
		}
		creds.Endpoint = endpoint
	} else {
		// Load everything from config
		var err error
		creds, err = cmd.LoadCredentials()
		if err != nil {
			return nil, fmt.Errorf("loading credentials: %w", err)
		}
		if creds == nil {
			return nil, fmt.Errorf("no credentials configured. Run 'permify configure'")
		}
	}

	// Build gRPC dial options
	var opts []grpc.DialOption

	if creds.Insecure {
		opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	} else if creds.CertPath != "" {
		// mTLS: load client certificate
		cert, err := tls.LoadX509KeyPair(creds.CertPath, creds.CertKey)
		if err != nil {
			return nil, fmt.Errorf("loading client certificate: %w", err)
		}

		certPool, err := x509.SystemCertPool()
		if err != nil {
			certPool = x509.NewCertPool()
		}

		tlsConfig := &tls.Config{
			Certificates: []tls.Certificate{cert},
			RootCAs:      certPool,
			MinVersion:   tls.VersionTLS12,
		}

		opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)))
	} else {
		// System TLS (default)
		opts = append(opts, grpc.WithTransportCredentials(credentials.NewClientTLSFromCert(nil, "")))
	}

	// Per-RPC token auth
	if creds.Token != "" {
		opts = append(opts, grpc.WithPerRPCCredentials(&tokenAuth{token: creds.Token}))
	}

	conn, err := grpc.Dial(creds.Endpoint, opts...)
	if err != nil {
		return nil, fmt.Errorf("connecting to %s: %w", creds.Endpoint, err)
	}

	return permify.NewClient(conn), nil
}

// tokenAuth implements credentials.PerRPCCredentials for bearer token auth.
type tokenAuth struct {
	token string
}

func (t *tokenAuth) GetRequestMetadata(ctx context.Context, uri ...string) (map[string]string, error) {
	return map[string]string{
		"authorization": "Bearer " + t.token,
	}, nil
}

func (t *tokenAuth) RequireTransportSecurity() bool {
	return true
}

// ── configure command ──────────────────────────────────────────────────────

// NewConfigureCommand returns the "configure" subcommand.
func NewConfigureCommand() *cobra.Command {
	var (
		endpoint string
		token    string
		certPath string
		certKey  string
		insecure bool
	)

	cmd := &cobra.Command{
		Use:   "configure",
		Short: "Configure Permify CLI credentials",
		Long: `Store Permify connection credentials for later use.
Credentials are saved to ~/.permify/config.json with restricted permissions.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			creds := &cmd.Credentials{
				Endpoint: endpoint,
				Token:    token,
				CertPath: certPath,
				CertKey:  certKey,
				Insecure: insecure,
			}
			return cmd.SaveCredentials(creds)
		},
	}

	cmd.Flags().StringVarP(&endpoint, "endpoint", "e", "localhost:3478", "Permify gRPC endpoint")
	cmd.Flags().StringVarP(&token, "token", "t", "", "Bearer token for authentication")
	cmd.Flags().StringVar(&certPath, "cert-path", "", "Path to TLS client certificate")
	cmd.Flags().StringVar(&certKey, "cert-key", "", "Path to TLS client certificate key")
	cmd.Flags().BoolVar(&insecure, "insecure", false, "Skip TLS verification")

	return cmd
}

// ── status command ─────────────────────────────────────────────────────────

// NewStatusCommand shows current credentials (token masked).
func NewStatusCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show current configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			creds, err := cmd.LoadCredentials()
			if err != nil {
				return err
			}
			if creds == nil {
				fmt.Println("No credentials configured. Run 'permify configure'")
				return nil
			}

			maskedToken := ""
			if creds.Token != "" {
				if len(creds.Token) > 8 {
					maskedToken = creds.Token[:4] + "..." + creds.Token[len(creds.Token)-4:]
				} else {
					maskedToken = "****"
				}
			}

			fmt.Printf("Endpoint:  %s\n", creds.Endpoint)
			fmt.Printf("Token:     %s\n", maskedToken)
			fmt.Printf("Cert Path: %s\n", creds.CertPath)
			fmt.Printf("Cert Key:  %s\n", creds.CertKey)
			fmt.Printf("Insecure:  %v\n", creds.Insecure)
			return nil
		},
	}
}
