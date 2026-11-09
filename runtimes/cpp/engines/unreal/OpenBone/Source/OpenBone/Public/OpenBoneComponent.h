// OpenBone component for Unreal Engine 5: plays a .obone/.obonb document (animations or a state machine) and
// rebuilds a procedural mesh (one section per draw item) every tick. Skeleton space maps to the component's X/Z
// plane (x right, y up → Z), 1 skeleton unit = 1 cm × PixelsToUnits.
// SPDX-License-Identifier: MIT
#pragma once

#include "CoreMinimal.h"
#include "ProceduralMeshComponent.h"
#include "OpenBoneComponent.generated.h"

struct ob_document;
struct ob_instance;
class UTexture2D;
class UMaterialInterface;
class UMaterialInstanceDynamic;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_FiveParams(FOpenBoneEvent, const FString&, Name, float, Time, int32, IntValue, float, FloatValue, const FString&, StringValue);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FOpenBoneAudio, const FString&, Command, const FString&, Sound, float, Volume);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FOpenBoneStateChange, const FString&, Layer, const FString&, From, const FString&, To);

UCLASS(ClassGroup = (OpenBone), meta = (BlueprintSpawnableComponent))
class OPENBONE_API UOpenBoneComponent : public UProceduralMeshComponent
{
	GENERATED_BODY()

public:
	UOpenBoneComponent(const FObjectInitializer& ObjectInitializer);

	/** .obone / .obonb file, absolute or relative to the project's Content directory. */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenBone")
	FString DocumentPath;

	/** Animation played on BeginPlay when no state machine is set. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone")
	FString Animation;

	/** State machine started on BeginPlay (takes precedence over Animation). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone")
	FString StateMachine;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone")
	FString Skin;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone")
	bool bLoop = true;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone")
	float Speed = 1.f;

	/** World units per skeleton unit. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone")
	float PixelsToUnits = 1.f;

	/** Gap between consecutive draw items along -Y, so later items draw in front without z-fighting. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone")
	float LayerSpacing = 0.01f;

	/**
	 * Translucent, two-sided, unlit material with a texture parameter "Texture" multiplied by vertex colour (and an
	 * optional vector parameter "Dark" for two-colour tint). Additive/multiply blend items use the matching variants.
	 */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone|Rendering")
	TObjectPtr<UMaterialInterface> Material;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone|Rendering")
	TObjectPtr<UMaterialInterface> AdditiveMaterial;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone|Rendering")
	TObjectPtr<UMaterialInterface> MultiplyMaterial;

	/** Run document scripts in the embedded QuickJS sandbox. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "OpenBone")
	bool bEnableScripts = true;

	UPROPERTY(BlueprintAssignable, Category = "OpenBone")
	FOpenBoneEvent OnEvent;
	UPROPERTY(BlueprintAssignable, Category = "OpenBone")
	FOpenBoneAudio OnAudio;
	UPROPERTY(BlueprintAssignable, Category = "OpenBone")
	FOpenBoneStateChange OnStateChange;

	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	bool LoadDocument(const FString& Path);
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	bool Play(const FString& Name, bool bLooping = true, int32 Track = 0);
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	bool UseStateMachine(const FString& Name);
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	bool SetBoolInput(const FString& Name, bool Value);
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	bool SetNumberInput(const FString& Name, float Value);
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	bool SetStringInput(const FString& Name, const FString& Value);
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	bool FireTrigger(const FString& Name);
	/** Pointer in skeleton space (x right, y up). 0 = down, 1 = up, 4 = move. */
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	void Pointer(int32 Type, FVector2D SkeletonPosition);
	/** Pointer from a world-space hit on the component's plane. */
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	void PointerAtWorld(int32 Type, FVector WorldPosition);
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	FString GetActiveState(int32 Layer = 0) const;
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	void SetSkin(const FString& Name);
	UFUNCTION(BlueprintCallable, Category = "OpenBone")
	void Advance(float DeltaSeconds);

	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type Reason) override;
	virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;
	virtual void OnRegister() override;

private:
	ob_document* Doc = nullptr;
	ob_instance* Inst = nullptr;
	FString LoadedPath;

	UPROPERTY(Transient)
	TMap<FString, TObjectPtr<UTexture2D>> Textures;
	UPROPERTY(Transient)
	TArray<TObjectPtr<UMaterialInstanceDynamic>> SectionMaterials;

	void Release();
	void Start();
	void RebuildMesh();
	UTexture2D* TextureFor(const char* Id, const char* Src);
	UMaterialInstanceDynamic* MaterialFor(int32 Section, int32 Blend, UTexture2D* Texture, const float* Dark);

	static void HandleEvent(void* User, const struct ob_event* Event);
	static void HandleAudio(void* User, const struct ob_audio_command* Command);
	static void HandleState(void* User, const char* Layer, const char* From, const char* To);
};
