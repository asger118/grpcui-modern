package main

import (
	"reflect"
	"strings"
	"testing"

	"github.com/jhump/protoreflect/desc/protoparse"
)

func TestRelatedTypes(t *testing.T) {
	const src = `syntax = "proto3";
package kart;
import "google/protobuf/timestamp.proto";

// How worn the tires are.
enum TireCondition { TIRE_CONDITION_UNSPECIFIED = 0; NEW = 1; WORN = 2; }

message Kart {
  enum KartClass { KART_CLASS_UNSPECIFIED = 0; RENTAL = 1; }
  message Tire { TireCondition condition = 1; }
  KartClass class = 1;
  repeated Tire tires = 2;
  map<string, Lap> laps = 3;
  google.protobuf.Timestamp registered = 4;
}
message Lap { double seconds = 1; Lap previous = 2; }
message StartRequest { Kart kart = 1; Kart.Tire spare = 2; }
message StartResponse { string id = 1; }
service Karts { rpc Start(StartRequest) returns (StartResponse); }
`
	files, err := (&protoparse.Parser{
		IncludeSourceCodeInfo: true,
		Accessor:              protoparse.FileContentsFromMap(map[string]string{"kart.proto": src}),
	}).ParseFiles("kart.proto")
	if err != nil {
		t.Fatal(err)
	}
	md := files[0].FindService("kart.Karts").FindMethodByName("Start")

	defs := map[string]string{}
	got := relatedTypes(md, defs)
	want := []string{"kart.StartRequest", "kart.StartResponse", "kart.Kart", "kart.TireCondition", "kart.Lap"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("relatedTypes = %v, want %v", got, want)
	}
	if len(defs) != len(want) {
		t.Errorf("defs has %d entries, want %d", len(defs), len(want))
	}
	if !strings.Contains(defs["kart.Kart"], "enum KartClass") || !strings.Contains(defs["kart.Kart"], "map<string, Lap>") {
		t.Errorf("Kart definition should include nested enum and map field:\n%s", defs["kart.Kart"])
	}
	if !strings.Contains(defs["kart.TireCondition"], "// How worn the tires are.") {
		t.Errorf("comments missing:\n%s", defs["kart.TireCondition"])
	}
}
