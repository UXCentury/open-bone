// SPDX-License-Identifier: MIT
#include "OpenBoneComponent.h"

#include "Engine/Texture2D.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/Base64.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"

THIRD_PARTY_INCLUDES_START
#include "openbone.h"
THIRD_PARTY_INCLUDES_END

namespace
{
FString Str(const char* S) { return S ? FString(UTF8_TO_TCHAR(S)) : FString(); }

// Particle dot sprite (same falloff as openbone::particleDotAlpha).
float DotAlpha(float R)
{
	const float Base = R >= 1.f ? 0.f : R <= 0.35f ? 1.f : 1.f - (R - 0.35f) / 0.65f;
	return FMath::Pow(Base, 1.6f);
}
} // namespace

UOpenBoneComponent::UOpenBoneComponent(const FObjectInitializer& ObjectInitializer) : Super(ObjectInitializer)
{
	PrimaryComponentTick.bCanEverTick = true;
	bUseAsyncCooking = true;
}

void UOpenBoneComponent::OnRegister()
{
	Super::OnRegister();
	// Show the setup pose in the editor.
	if (!Inst && !DocumentPath.IsEmpty()) LoadDocument(DocumentPath);
}

void UOpenBoneComponent::BeginPlay()
{
	Super::BeginPlay();
	if (!Inst && !DocumentPath.IsEmpty()) LoadDocument(DocumentPath);
	Start();
}

void UOpenBoneComponent::EndPlay(const EEndPlayReason::Type Reason)
{
	Release();
	Super::EndPlay(Reason);
}

void UOpenBoneComponent::Release()
{
	if (Inst) ob_instance_free(Inst);
	if (Doc) ob_document_free(Doc);
	Inst = nullptr;
	Doc = nullptr;
	Textures.Empty();
	SectionMaterials.Empty();
}

bool UOpenBoneComponent::LoadDocument(const FString& Path)
{
	Release();
	FString Full = FPaths::IsRelative(Path) ? FPaths::Combine(FPaths::ProjectContentDir(), Path) : Path;
	TArray<uint8> Bytes;
	if (!FFileHelper::LoadFileToArray(Bytes, *Full))
	{
		UE_LOG(LogTemp, Error, TEXT("OpenBone: cannot read %s"), *Full);
		return false;
	}
	Doc = ob_document_load_memory(Bytes.GetData(), Bytes.Num());
	if (!Doc)
	{
		UE_LOG(LogTemp, Error, TEXT("OpenBone: %s: %s"), *Full, *Str(ob_last_error()));
		return false;
	}
	Inst = ob_instance_create(Doc, bEnableScripts ? OB_INSTANCE_SCRIPTS : 0);
	ob_instance_set_event_callback(Inst, &UOpenBoneComponent::HandleEvent, this);
	ob_instance_set_audio_callback(Inst, &UOpenBoneComponent::HandleAudio, this);
	ob_instance_set_state_callback(Inst, &UOpenBoneComponent::HandleState, this);
	LoadedPath = Full;
	if (!Skin.IsEmpty()) ob_instance_set_skin(Inst, TCHAR_TO_UTF8(*Skin));
	ob_instance_advance(Inst, 0);
	RebuildMesh();
	return true;
}

void UOpenBoneComponent::Start()
{
	if (!Inst) return;
	if (!StateMachine.IsEmpty()) UseStateMachine(StateMachine);
	else if (!Animation.IsEmpty()) Play(Animation, bLoop);
}

bool UOpenBoneComponent::Play(const FString& Name, bool bLooping, int32 Track)
{
	return Inst && ob_instance_play(Inst, TCHAR_TO_UTF8(*Name), bLooping ? 1 : 0, Track) == 1;
}

bool UOpenBoneComponent::UseStateMachine(const FString& Name)
{
	return Inst && ob_instance_use_state_machine(Inst, Name.IsEmpty() ? nullptr : TCHAR_TO_UTF8(*Name)) == 1;
}

bool UOpenBoneComponent::SetBoolInput(const FString& Name, bool Value) { return Inst && ob_instance_set_bool(Inst, TCHAR_TO_UTF8(*Name), Value) == 1; }
bool UOpenBoneComponent::SetNumberInput(const FString& Name, float Value) { return Inst && ob_instance_set_number(Inst, TCHAR_TO_UTF8(*Name), Value) == 1; }
bool UOpenBoneComponent::SetStringInput(const FString& Name, const FString& Value)
{
	return Inst && ob_instance_set_string(Inst, TCHAR_TO_UTF8(*Name), TCHAR_TO_UTF8(*Value)) == 1;
}
bool UOpenBoneComponent::FireTrigger(const FString& Name) { return Inst && ob_instance_fire(Inst, TCHAR_TO_UTF8(*Name)) == 1; }

void UOpenBoneComponent::Pointer(int32 Type, FVector2D P)
{
	if (Inst) ob_instance_pointer(Inst, (ob_pointer_type)Type, P.X, P.Y);
}

void UOpenBoneComponent::PointerAtWorld(int32 Type, FVector WorldPosition)
{
	const FVector Local = GetComponentTransform().InverseTransformPosition(WorldPosition);
	Pointer(Type, FVector2D(Local.X / PixelsToUnits, Local.Z / PixelsToUnits));
}

FString UOpenBoneComponent::GetActiveState(int32 Layer) const
{
	const char* LayerName = nullptr;
	const char* State = nullptr;
	if (!Inst || !ob_instance_active_state(Inst, Layer, &LayerName, &State)) return FString();
	return Str(State);
}

void UOpenBoneComponent::SetSkin(const FString& Name)
{
	Skin = Name;
	if (!Inst) return;
	ob_instance_set_skin(Inst, Name.IsEmpty() ? nullptr : TCHAR_TO_UTF8(*Name));
	ob_instance_advance(Inst, 0);
	RebuildMesh();
}

void UOpenBoneComponent::Advance(float DeltaSeconds)
{
	if (!Inst) return;
	ob_instance_advance(Inst, DeltaSeconds);
	RebuildMesh();
}

void UOpenBoneComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
	Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
	Advance(DeltaTime * Speed);
}

UTexture2D* UOpenBoneComponent::TextureFor(const char* Id, const char* Src)
{
	const FString Key = Str(Id);
	if (TObjectPtr<UTexture2D>* Found = Textures.Find(Key)) return *Found;
	UTexture2D* Tex = nullptr;
	TArray<uint8> Rgba;
	int32 W = 0, H = 0;
	if (Key == TEXT("@openbone/particle-dot"))
	{
		W = H = 64;
		Rgba.SetNumUninitialized(W * H * 4);
		for (int32 Y = 0; Y < H; Y++)
			for (int32 X = 0; X < W; X++)
			{
				const float Dx = (X + 0.5f) / W * 2 - 1, Dy = (Y + 0.5f) / H * 2 - 1;
				uint8* P = &Rgba[(Y * W + X) * 4];
				P[0] = P[1] = P[2] = 255;
				P[3] = (uint8)FMath::RoundToInt(DotAlpha(FMath::Sqrt(Dx * Dx + Dy * Dy)) * 255);
			}
	}
	else if (Src)
	{
		TArray<uint8> Bytes;
		const FString S = Str(Src);
		if (S.StartsWith(TEXT("data:")))
		{
			int32 Comma;
			if (S.FindChar(TEXT(','), Comma)) FBase64::Decode(S.Mid(Comma + 1), Bytes);
		}
		else
			FFileHelper::LoadFileToArray(Bytes, *FPaths::Combine(FPaths::GetPath(LoadedPath), S));
		IImageWrapperModule& Wrappers = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		const EImageFormat Format = Wrappers.DetectImageFormat(Bytes.GetData(), Bytes.Num());
		TSharedPtr<IImageWrapper> Wrapper = Format == EImageFormat::Invalid ? nullptr : Wrappers.CreateImageWrapper(Format);
		if (Wrapper.IsValid() && Wrapper->SetCompressed(Bytes.GetData(), Bytes.Num()) && Wrapper->GetRaw(ERGBFormat::RGBA, 8, Rgba))
		{
			W = Wrapper->GetWidth();
			H = Wrapper->GetHeight();
		}
	}
	if (W > 0 && H > 0)
	{
		Tex = UTexture2D::CreateTransient(W, H, PF_R8G8B8A8);
		void* Mip = Tex->GetPlatformData()->Mips[0].BulkData.Lock(LOCK_READ_WRITE);
		FMemory::Memcpy(Mip, Rgba.GetData(), Rgba.Num());
		Tex->GetPlatformData()->Mips[0].BulkData.Unlock();
		Tex->SRGB = true;
		Tex->UpdateResource();
	}
	Textures.Add(Key, Tex);
	return Tex;
}

UMaterialInstanceDynamic* UOpenBoneComponent::MaterialFor(int32 Section, int32 Blend, UTexture2D* Texture, const float* Dark)
{
	UMaterialInterface* Base = Blend == OB_BLEND_ADDITIVE || Blend == OB_BLEND_SCREEN ? (AdditiveMaterial ? AdditiveMaterial : Material)
	                        : Blend == OB_BLEND_MULTIPLY                                ? (MultiplyMaterial ? MultiplyMaterial : Material)
	                                                                                    : Material;
	if (!Base) return nullptr;
	while (SectionMaterials.Num() <= Section) SectionMaterials.Add(nullptr);
	UMaterialInstanceDynamic*& Mid = SectionMaterials[Section];
	if (!Mid || Mid->Parent != Base) Mid = UMaterialInstanceDynamic::Create(Base, this);
	Mid->SetTextureParameterValue(TEXT("Texture"), Texture);
	Mid->SetVectorParameterValue(TEXT("Dark"), Dark ? FLinearColor(Dark[0], Dark[1], Dark[2], 1) : FLinearColor(0, 0, 0, 0));
	return Mid;
}

void UOpenBoneComponent::RebuildMesh()
{
	if (!Inst) return;
	const int32 Count = ob_instance_update_draw_list(Inst);
	int32 Section = 0;
	for (int32 I = 0; I < Count; I++)
	{
		ob_draw_item It;
		if (!ob_instance_draw_item(Inst, I, &It) || It.kind == OB_ITEM_TEXT) continue;
		TArray<FVector> Vertices;
		TArray<int32> Triangles;
		TArray<FVector> Normals;
		TArray<FVector2D> UV0;
		TArray<FLinearColor> Colors;
		TArray<FProcMeshTangent> Tangents;
		const float Depth = -I * LayerSpacing;
		for (int32 V = 0; V < It.vertex_count; V++)
		{
			Vertices.Add(FVector(It.vertices[V * 2] * PixelsToUnits, Depth, It.vertices[V * 2 + 1] * PixelsToUnits));
			Normals.Add(FVector(0, -1, 0));
			UV0.Add(FVector2D(It.uvs[V * 2], It.uvs[V * 2 + 1]));
			Colors.Add(It.colors ? FLinearColor(It.colors[V * 4], It.colors[V * 4 + 1], It.colors[V * 4 + 2], It.colors[V * 4 + 3])
			                     : FLinearColor(It.color[0], It.color[1], It.color[2], It.color[3]));
		}
		// Skeleton triangles are counter-clockwise seen from -Y; Unreal's front faces are clockwise.
		for (int32 K = 0; K + 2 < It.index_count; K += 3)
		{
			Triangles.Add(It.indices[K]);
			Triangles.Add(It.indices[K + 2]);
			Triangles.Add(It.indices[K + 1]);
		}
		CreateMeshSection_LinearColor(Section, Vertices, Triangles, Normals, UV0, Colors, Tangents, false);
		UTexture2D* Tex = It.texture_id ? TextureFor(It.texture_id, It.texture_src) : nullptr;
		if (UMaterialInstanceDynamic* Mid = MaterialFor(Section, It.blend, Tex, It.has_dark ? It.dark : nullptr)) SetMaterial(Section, Mid);
		Section++;
	}
	for (int32 S = Section; S < GetNumSections(); S++) ClearMeshSection(S);
}

void UOpenBoneComponent::HandleEvent(void* User, const ob_event* E)
{
	auto* Self = static_cast<UOpenBoneComponent*>(User);
	Self->OnEvent.Broadcast(Str(E->name), (float)E->time, (int32)E->int_value, (float)E->float_value, Str(E->string_value));
}

void UOpenBoneComponent::HandleAudio(void* User, const ob_audio_command* C)
{
	auto* Self = static_cast<UOpenBoneComponent*>(User);
	const TCHAR* Type = C->type == OB_AUDIO_PLAY ? TEXT("play") : C->type == OB_AUDIO_STOP ? TEXT("stop") : TEXT("fade");
	Self->OnAudio.Broadcast(Type, Str(C->sound), (float)C->volume);
}

void UOpenBoneComponent::HandleState(void* User, const char* Layer, const char* From, const char* To)
{
	static_cast<UOpenBoneComponent*>(User)->OnStateChange.Broadcast(Str(Layer), Str(From), Str(To));
}
